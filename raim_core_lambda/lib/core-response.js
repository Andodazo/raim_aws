'use strict';

// ==============================================================================
// Core Lambda Response Factory
// ==============================================================================
//
// 【このファイルの役割】
// Core LambdaからEdge Lambdaへ返す成功・失敗レスポンスの形を統一する。
// types.jsのchat/error形式へ、Core間連携に必要なokとrequestIdを追加する。
//
// 【ここでHTTP形式にしない理由】
// Core LambdaはAPI Gatewayへ直接返す層ではない。
// statusCodeやCORS headerはEdge Lambda側で決めるため、ここでは純粋なJSONを返す。
//
// 【requestId】
// Edge Lambdaが「どの要求に対する応答か」を対応付けるため、成功・失敗の両方に
// 必ずrequestIdを含める。
// ==============================================================================

const { createChat, createError } = require('./types');

/**
 * _imageDescriptionなど、Core内部だけで使うフィールドを外部レスポンスから除く。
 * underscore prefixを内部用という規約にすることで、個別キーの削除漏れを防ぐ。
 */
function removeInternalFields(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !key.startsWith('_'))
  );
}

/**
 * Mantle出力をEdge Lambda向けの正常レスポンスへ変換する。
 * createChat()を通すため、emotion/intensityの基本的な型・範囲も統一される。
 */
function createCoreChat({ requestId, text, emotion, intensity }) {
  const chat = removeInternalFields(createChat({ text, emotion, intensity }));

  return {
    ok: true,
    ...chat,
    requestId: String(requestId || ''),
  };
}

/**
 * 入力不正、Mantle/Titan障害、内部例外を共通の失敗レスポンスへ変換する。
 * detailsはtypes.jsの規則に従い、NODE_ENV=productionでは含まれない。
 */
function createCoreError({ requestId, code, message, retriable, details }) {
  const error = createError({ code, message, retriable, details });

  return {
    ok: false,
    ...error,
    requestId: String(requestId || ''),
  };
}

module.exports = {
  createCoreChat,
  createCoreError,
  removeInternalFields,
};
