'use strict';

const {
  ChangePasswordCommand,
  CognitoIdentityProviderClient,
} = require('@aws-sdk/client-cognito-identity-provider');
const { CognitoJwtVerifier } = require('aws-jwt-verify');

const cognitoClient = new CognitoIdentityProviderClient({});
const verifierCache = new Map();
const REQUIRED_SCOPE = 'aws.cognito.signin.user.admin';

async function handler(event) {
  try {
    return await handlePasswordChange(event);
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

    if (
      error?.name === 'NotAuthorizedException' ||
      error?.name === 'UserNotFoundException'
    ) {
      return createResponse(400, {
        message: 'Current password is invalid.',
      });
    }

    if (error?.name === 'TooManyRequestsException') {
      return createResponse(429, { message: 'Too many requests.' });
    }

    console.error('Password change failed', {
      errorName: error?.name || 'Error',
    });
    return createResponse(500, { message: 'Internal server error.' });
  }
}

async function handlePasswordChange(
  event,
  {
    verifyToken = verifyAccessToken,
    changePassword = changeUserPassword,
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

  if (!hasRequiredScope(claims)) {
    throw new HttpError(403, 'Password change permission is required.');
  }

  const { previousPassword, proposedPassword } = readPasswordChangeRequest(event);

  await changePassword({
    accessToken: token,
    previousPassword,
    proposedPassword,
  });

  return createResponse(200, {
    message: 'Password changed successfully.',
  });
}

function getConfig(env) {
  return {
    userPoolId: readRequiredString(env, 'COGNITO_USER_POOL_ID'),
    clientId: readRequiredString(env, 'COGNITO_APP_CLIENT_ID'),
  };
}

function readRequiredString(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readPasswordChangeRequest(event) {
  const body = parseBody(event);
  const previousPassword = body?.previousPassword;
  const proposedPassword = body?.proposedPassword;

  if (
    typeof previousPassword !== 'string' ||
    previousPassword.length === 0 ||
    previousPassword.length > 256
  ) {
    throw new HttpError(400, 'A valid current password is required.');
  }

  if (
    typeof proposedPassword !== 'string' ||
    proposedPassword.length === 0 ||
    proposedPassword.length > 256
  ) {
    throw new HttpError(400, 'A valid new password is required.');
  }

  return { previousPassword, proposedPassword };
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

function hasRequiredScope(claims) {
  return String(claims?.scope || '')
    .split(/\s+/)
    .filter(Boolean)
    .includes(REQUIRED_SCOPE);
}

async function changeUserPassword({
  accessToken,
  previousPassword,
  proposedPassword,
}) {
  await cognitoClient.send(
    new ChangePasswordCommand({
      AccessToken: accessToken,
      PreviousPassword: previousPassword,
      ProposedPassword: proposedPassword,
    }),
  );
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
  handlePasswordChange,
  hasRequiredScope,
  readPasswordChangeRequest,
};

