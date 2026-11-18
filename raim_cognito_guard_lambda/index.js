'use strict';

const {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const BLOCK_ENABLED_ENV = 'PRESIGNUP_EXTERNAL_PROVIDER_BLOCK_ENABLED';
const NATIVE_SIGNUP_BLOCK_ENABLED_ENV =
  'BLOCK_NATIVE_SIGNUP_FOR_FEDERATED_EMAIL_ENABLED';
const EXTERNAL_PROVIDER_TRIGGER = 'PreSignUp_ExternalProvider';
const NATIVE_SIGNUP_TRIGGER = 'PreSignUp_SignUp';

const cognitoClient = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  return handlePreSignUp(event);
};

async function handlePreSignUp(
  event,
  {
    listUsers = listUsersByEmail,
    env = process.env,
  } = {},
) {
  if (event.triggerSource === EXTERNAL_PROVIDER_TRIGGER) {
    if (isEnabled(env, BLOCK_ENABLED_ENV)) {
      throw new Error('New OAuth users are not allowed.');
    }

    return event;
  }

  if (
    event.triggerSource === NATIVE_SIGNUP_TRIGGER &&
    isEnabled(env, NATIVE_SIGNUP_BLOCK_ENABLED_ENV)
  ) {
    const email = event.request?.userAttributes?.email;

    if (email && event.userPoolId) {
      const users = await listUsers(event.userPoolId, email);

      if (users.some(hasGoogleIdentity)) {
        throw new Error('Unable to complete registration safely.');
      }
    }
  }

  return event;
}

function isEnabled(env, name) {
  return (env[name] || '').trim().toLowerCase() === 'true';
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

function hasGoogleIdentity(user) {
  const rawIdentities = getAttribute(user, 'identities');
  if (!rawIdentities) return false;

  try {
    const identities = JSON.parse(rawIdentities);
    return Array.isArray(identities) && identities.some(
      (identity) => identity?.providerName === 'Google',
    );
  } catch {
    return false;
  }
}

function getAttribute(user, name) {
  return user?.Attributes?.find((attribute) => attribute.Name === name)?.Value;
}

module.exports.handlePreSignUp = handlePreSignUp;
