'use strict';

const {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminLinkProviderForUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const { CognitoJwtVerifier } = require('aws-jwt-verify');
const crypto = require('node:crypto');

const cognitoClient = new CognitoIdentityProviderClient({});
const verifierCache = new Map();
const DEFAULT_MAX_AUTH_AGE_SECONDS = 900;

async function handler(event) {
  try {
    return await handleAccountLink(event);
  } catch (error) {
    if (error instanceof HttpError) {
      return createResponse(error.statusCode, { message: error.publicMessage });
    }

    if (
      error?.name === 'InvalidPasswordException' ||
      error?.name === 'PasswordHistoryPolicyViolationException'
    ) {
      return createResponse(400, {
        message: 'Password does not meet the user pool policy.',
      });
    }

    if (error?.name === 'UsernameExistsException' || error?.name === 'AliasExistsException') {
      return createResponse(409, {
        message: 'The account could not be created because it already exists.',
      });
    }

    if (error?.name === 'TooManyRequestsException') {
      return createResponse(429, { message: 'Too many requests.' });
    }

    console.error('Account link failed', {
      errorName: error?.name || 'Error',
    });
    return createResponse(500, { message: 'Internal server error.' });
  }
}

async function handleAccountLink(
  event,
  {
    verifyToken = verifyAccessToken,
    getUser = getUserByUsername,
    listUsers = listUsersByEmail,
    createUser = createStandardUser,
    setPassword = setUserPassword,
    deleteUser = deleteFederatedUser,
    linkProvider = linkGoogleProvider,
    env = process.env,
  } = {},
) {
  const config = getConfig(env);
  const token = extractBearerToken(event);

  let claims;
  try {
    claims = await verifyToken(token, config);
  } catch (error) {
    console.error('Access token verification failed', {
      errorName: error?.name || 'Error',
    });
    throw new HttpError(401, 'Unauthorized.');
  }

  validateRecentAuthentication(
    claims,
    config.maxAuthAgeSeconds,
    Math.floor(Date.now() / 1000),
  );

  if (!claims.sub || !claims.username) {
    throw new HttpError(401, 'Unauthorized.');
  }

  const sourceUser = await getUser(
    claims.username,
    config.userPoolId,
  );

  if (getAttribute(sourceUser, 'sub') !== claims.sub) {
    throw new HttpError(401, 'Unauthorized.');
  }

  const googleIdentity = getGoogleIdentity(sourceUser);
  if (
    sourceUser.UserStatus !== 'EXTERNAL_PROVIDER' &&
    googleIdentity &&
    getAttribute(sourceUser, 'email_verified') === 'true'
  ) {
    return createResponse(200, {
      message: 'Account is already linked.',
    });
  }

  if (
    sourceUser.UserStatus !== 'EXTERNAL_PROVIDER' ||
    !googleIdentity ||
    getAttribute(sourceUser, 'email_verified') !== 'true'
  ) {
    throw new HttpError(409, 'Google account linking is not available for this user.');
  }

  const { proposedPassword } = readAccountLinkRequest(event);
  const email = normalizeEmail(getAttribute(sourceUser, 'email'));
  if (!email) {
    throw new HttpError(409, 'A verified email address is required.');
  }

  const users = await listUsers(config.userPoolId, email);

  if (users.some(
    (user) => hasGoogleIdentity(user, googleIdentity.userId),
  )) {
    return createResponse(200, {
      message: 'Account is already linked.',
    });
  }

  const localUsers = users.filter(isLocalUser);
  if (localUsers.length > 1) {
    throw new HttpError(409, 'Multiple standard accounts require support.');
  }

  let destinationUser = localUsers[0];
  if (destinationUser) {
    if (getAttribute(destinationUser, 'email_verified') !== 'true') {
      throw new HttpError(409, 'A verified email address is required.');
    }

    if (destinationUser.UserStatus !== 'CONFIRMED') {
      await setPassword({
        userPoolId: config.userPoolId,
        username: destinationUser.Username,
        password: proposedPassword,
      });
    }
  } else {
    destinationUser = await createUser({
      userPoolId: config.userPoolId,
      email,
      subject: googleIdentity.userId,
    });

    await setPassword({
      userPoolId: config.userPoolId,
      username: destinationUser.Username,
      password: proposedPassword,
    });
  }

  // A federated profile that has already signed in must be removed before
  // AdminLinkProviderForUser can attach its provider identity to the local user.
  await deleteUser({
    userPoolId: config.userPoolId,
    username: sourceUser.Username,
  });

  await linkProvider({
    userPoolId: config.userPoolId,
    destinationUsername: destinationUser.Username,
    subject: googleIdentity.userId,
  });

  return createResponse(200, {
    message: 'Account linked successfully. Please sign in again.',
  });
}

function getConfig(env) {
  const rawMaxAge = String(
    env.ACCOUNT_LINK_MAX_AUTH_AGE_SECONDS || DEFAULT_MAX_AUTH_AGE_SECONDS,
  ).trim();
  const maxAuthAgeSeconds = Number(rawMaxAge);

  if (!Number.isInteger(maxAuthAgeSeconds) || maxAuthAgeSeconds <= 0) {
    throw new Error('ACCOUNT_LINK_MAX_AUTH_AGE_SECONDS must be a positive integer');
  }

  return {
    userPoolId: readRequiredString(env, 'COGNITO_USER_POOL_ID'),
    clientId: readRequiredString(env, 'COGNITO_APP_CLIENT_ID'),
    maxAuthAgeSeconds,
  };
}

function readRequiredString(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readAccountLinkRequest(event) {
  const body = parseBody(event);
  const proposedPassword = body?.proposedPassword;

  if (
    typeof proposedPassword !== 'string' ||
    proposedPassword.length === 0 ||
    proposedPassword.length > 256
  ) {
    throw new HttpError(400, 'A valid password is required.');
  }

  return { proposedPassword };
}

function parseBody(event) {
  if (event?.body && typeof event.body === 'object') {
    return event.body;
  }

  if (typeof event?.body !== 'string' || event.body.length === 0) {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  try {
    return JSON.parse(rawBody);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function extractBearerToken(event) {
  const headers = event?.headers || {};
  const authorization = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'authorization',
  )?.[1];
  const value = String(authorization || '').trim();
  const match = value.match(/^Bearer\s+(.+)$/i);

  if (!match || !match[1].trim()) {
    throw new HttpError(401, 'Authorization token is required.');
  }

  return match[1].trim();
}

async function verifyAccessToken(token, config) {
  const cacheKey = `${config.userPoolId}:${config.clientId}`;
  let verifier = verifierCache.get(cacheKey);

  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: config.userPoolId,
      clientId: config.clientId,
      tokenUse: 'access',
    });
    verifierCache.set(cacheKey, verifier);
  }

  return verifier.verify(token);
}

function validateRecentAuthentication(claims, maxAuthAgeSeconds, currentTime) {
  const authTime = Number(claims.auth_time);

  if (!Number.isFinite(authTime)) {
    throw new HttpError(401, 'Recent authentication is required.');
  }

  if (authTime > currentTime + 30 || currentTime - authTime > maxAuthAgeSeconds) {
    throw new HttpError(401, 'Recent authentication is required.');
  }
}

async function getUserByUsername(username, userPoolId) {
  try {
    return await cognitoClient.send(
      new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: username,
      }),
    );
  } catch (error) {
    if (error?.name === 'UserNotFoundException') {
      throw new HttpError(401, 'Unauthorized.');
    }
    throw error;
  }
}

async function listUsersByEmail(userPoolId, email) {
  const escapedEmail = email.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const users = [];
  let paginationToken;

  do {
    const response = await cognitoClient.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        Filter: `email = "${escapedEmail}"`,
        Limit: 60,
        PaginationToken: paginationToken,
      }),
    );

    users.push(...(response.Users || []));
    paginationToken = response.PaginationToken;
  } while (paginationToken);

  return users;
}

async function createStandardUser({ userPoolId, email, subject }) {
  const username = `raim_${subject}`;
  const temporaryPassword = `Raim_${crypto.randomBytes(24).toString('base64url')}9!`;

  const response = await cognitoClient.send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: username,
      TemporaryPassword: temporaryPassword,
      MessageAction: 'SUPPRESS',
      ForceAliasCreation: true,
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
      ],
    }),
  );

  return response.User;
}

async function setUserPassword({ userPoolId, username, password }) {
  await cognitoClient.send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: username,
      Password: password,
      Permanent: true,
    }),
  );
}

async function deleteFederatedUser({ userPoolId, username }) {
  await cognitoClient.send(
    new AdminDeleteUserCommand({
      UserPoolId: userPoolId,
      Username: username,
    }),
  );
}

async function linkGoogleProvider({ userPoolId, destinationUsername, subject }) {
  await cognitoClient.send(
    new AdminLinkProviderForUserCommand({
      UserPoolId: userPoolId,
      DestinationUser: {
        ProviderName: 'Cognito',
        ProviderAttributeValue: destinationUsername,
      },
      SourceUser: {
        ProviderName: 'Google',
        ProviderAttributeName: 'Cognito_Subject',
        ProviderAttributeValue: subject,
      },
    }),
  );
}

function getGoogleIdentity(user) {
  const rawIdentities = getAttribute(user, 'identities');
  if (!rawIdentities) return null;

  try {
    const identities = JSON.parse(rawIdentities);
    const identity = identities.find(
      (candidate) => candidate?.providerName === 'Google' && candidate?.userId,
    );

    return identity
      ? { userId: identity.userId }
      : null;
  } catch {
    return null;
  }
}

function hasGoogleIdentity(user, subject) {
  return getGoogleIdentity(user)?.userId === subject;
}

function isLocalUser(user) {
  return user.UserStatus !== 'EXTERNAL_PROVIDER' && !getAttribute(user, 'identities');
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email || null;
}

function getAttribute(user, name) {
  return user?.UserAttributes?.find((attribute) => attribute.Name === name)?.Value;
}

function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

class HttpError extends Error {
  constructor(statusCode, publicMessage) {
    super(publicMessage);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

module.exports = {
  handler,
  handleAccountLink,
  hasGoogleIdentity,
  isLocalUser,
  normalizeEmail,
};

