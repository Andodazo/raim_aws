'use strict';

const {
  AdminLinkProviderForUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

const cognitoClient = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  if (event.triggerSource !== 'InboundFederation_ExternalProvider') {
    return event;
  }

  if (event.request?.providerName !== 'Google') {
    return preserveProviderAttributes(event);
  }

  const identity = getGoogleIdentity(event);

  // Do not auto-link without Google's validated subject and verified email.
  if (!identity.subject || !identity.email || !identity.emailVerified) {
    throw new Error('Unable to link the Google account safely.');
  }

  const users = await listUsersByEmail(event.userPoolId, identity.email);

  // Idempotency: an already-linked Google subject needs no second link call.
  if (users.some((user) => hasGoogleIdentity(user, identity.subject))) {
    return preserveProviderAttributes(event);
  }

  const localUsers = users.filter(isUnlinkedLocalUser);

  if (localUsers.length === 0) {
    // No matching local user: let Cognito create the normal federated profile.
    return preserveProviderAttributes(event);
  }

  if (localUsers.length !== 1) {
    throw new Error('Unable to link the Google account safely.');
  }

  const destinationUser = localUsers[0];
  if (getAttribute(destinationUser, 'email_verified') !== 'true') {
    throw new Error('Unable to link the Google account safely.');
  }

  await cognitoClient.send(
    new AdminLinkProviderForUserCommand({
      UserPoolId: event.userPoolId,
      DestinationUser: {
        ProviderName: 'Cognito',
        ProviderAttributeValue: destinationUser.Username,
      },
      SourceUser: {
        ProviderName: 'Google',
        ProviderAttributeName: 'Cognito_Subject',
        ProviderAttributeValue: identity.subject,
      },
    }),
  );

  return preserveProviderAttributes(event);
};

function getGoogleIdentity(event) {
  const idToken = event.request?.attributes?.idToken || {};

  return {
    subject: idToken.sub,
    email: idToken.email,
    emailVerified: idToken.email_verified === true || idToken.email_verified === 'true',
  };
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

function isUnlinkedLocalUser(user) {
  return user.UserStatus !== 'EXTERNAL_PROVIDER' && !getAttribute(user, 'identities');
}

function hasGoogleIdentity(user, subject) {
  const rawIdentities = getAttribute(user, 'identities');
  if (!rawIdentities) return false;

  try {
    const identities = JSON.parse(rawIdentities);
    return identities.some(
      (identity) => identity.providerName === 'Google' && identity.userId === subject,
    );
  } catch {
    return false;
  }
}

function getAttribute(user, name) {
  return user.Attributes?.find((attribute) => attribute.Name === name)?.Value;
}

function preserveProviderAttributes(event) {
  event.response = event.response || {};
  // Empty mapping tells Cognito to keep the original provider attributes.
  event.response.userAttributesToMap = {};
  return event;
}
