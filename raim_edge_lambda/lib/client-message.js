'use strict';

// ==============================================================================
// Client Message Mapper
// ==============================================================================
//
// Core LambdaからResponse Queueへ流れてくる内部イベントを、
// Flutter/Unityクライアントへ送りやすいWebSocketメッセージへ変換する。
//
// 内部イベントの例:
//   stream.start
//   stream.delta
//   stream.completed
//   stream.error
//
// クライアントにはtype/requestId/sequenceを必ず付ける。
// これにより、クライアント側で順序確認や重複除外を行いやすくする。

function toClientMessage(coreEvent) {
  const base = {
    type: coreEvent.type,
    requestId: coreEvent.requestId,
    sequence: coreEvent.sequence,
  };

  switch (coreEvent.type) {
    case 'stream.start':
      return {
        ...base,
      };

    case 'stream.delta':
      return {
        ...base,
        textDelta: String(coreEvent.textDelta || ''),
      };

    case 'stream.completed':
      return {
        ...base,
        text: String(coreEvent.text || ''),
        emotion: String(coreEvent.emotion || 'neutral'),
        intensity: typeof coreEvent.intensity === 'number'
          ? coreEvent.intensity
          : 0.5,
      };

    case 'stream.error':
      return {
        ...base,
        code: String(coreEvent.code || 'INTERNAL_ERROR'),
        message: String(coreEvent.message || 'Internal server error'),
        retriable: Boolean(coreEvent.retriable),
      };

    default:
      return {
        ...base,
        payload: coreEvent,
      };
  }
}

module.exports = {
  toClientMessage,
};
