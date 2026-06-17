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

/**
 * 保存済みのMantle response_idを使えるか判定する。
 *
 * lastResponseId があり、
 * lastResponseExpiresAt が現在時刻より未来なら true。
 */
function canUsePreviousResponseId(session) {
  if (!session) return false;

  if (!session.lastResponseId) {
    return false;
  }

  if (!session.lastResponseExpiresAt) {
    return false;
  }

  const expiresAt = new Date(session.lastResponseExpiresAt).getTime();

  if (Number.isNaN(expiresAt)) {
    return false;
  }

  return Date.now() < expiresAt;
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

    const usePreviousResponseId = canUsePreviousResponseId(session);

    return createResponse(200, {
      ...createChat({
        text: `入力チェックOK。Mantle用UserSessionを取得しました。text: ${validation.message.text}`,
        emotion: 'neutral',
        intensity: 0.5,
      }),
      debug: {
        sub,
        currentSessionId: session.currentSessionId,
        isNew: session.isNew,

        // Mantle response_id管理
        lastResponseId: session.lastResponseId || '',
        lastResponseCreatedAt: session.lastResponseCreatedAt || '',
        lastResponseExpiresAt: session.lastResponseExpiresAt || '',
        usePreviousResponseId,

        // response_idが使えないときにMantleへ渡す予定
        hasSessionSummary: Boolean(session.sessionSummary),
        promptVersion: session.promptVersion || '',
      },
    });
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