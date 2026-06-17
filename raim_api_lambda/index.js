'use strict';

const { getOrCreateUserSession } = require('./lib/user-session-store');
const {
  createChat,
  createError,
  ERROR_CODES,
  validateUpstream,
} = require('./lib/types');

function getSubFromEvent(event) {
  const claims =
    event.requestContext?.authorizer?.claims ||
    event.requestContext?.authorizer?.jwt?.claims;

  const sub = claims?.sub;

  if (!sub) {
    throw new Error('Cognito sub not found in requestContext.authorizer.claims');
  }

  return sub;
}

function parseBody(event) {
  if (!event.body) {
    return {};
  }

  if (typeof event.body === 'object') {
    return event.body;
  }

  try {
    return JSON.parse(event.body);
  } catch (error) {
    return null;
  }
}

function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  console.log('event:', JSON.stringify(event));

  try {
    const body = parseBody(event);

    if (!body) {
      return createResponse(
        400,
        createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: 'Request body must be valid JSON',
          retriable: false,
        })
      );
    }

    const validation = validateUpstream(body);

    if (!validation.valid) {
      return createResponse(
        400,
        createError({
          code: ERROR_CODES.INVALID_INPUT,
          message: validation.error,
          retriable: false,
        })
      );
    }

    const sub = getSubFromEvent(event);

    const session = await getOrCreateUserSession(sub);

    return createResponse(
      200,
      createChat({
        text: `入力チェックOK。UserSessionも取得しました。text: ${validation.message.text}`,
        emotion: 'neutral',
        intensity: 0.5,
      })
    );
  } catch (error) {
    console.error('error:', error);

    return createResponse(
      500,
      createError({
        code: ERROR_CODES.INTERNAL_ERROR,
        message: error.message || 'Internal Server Error',
        retriable: true,
        details: {
          name: error.name,
          stack: error.stack,
        },
      })
    );
  }
};