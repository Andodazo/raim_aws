'use strict';

function createHttpResponse(statusCode, body = {}) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

function createAcceptedResponse(payload = {}) {
  return createHttpResponse(202, {
    ok: true,
    ...payload,
  });
}

function createOkResponse(payload = {}) {
  return createHttpResponse(200, {
    ok: true,
    ...payload,
  });
}

module.exports = {
  createAcceptedResponse,
  createHttpResponse,
  createOkResponse,
};
