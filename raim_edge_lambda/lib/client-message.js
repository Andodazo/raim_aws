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

    // v14: tool intro の後に届く区切り。Flutterはこれを受けたら
    // 現在ストリーミング中の吹き出しを確定し、次のtext_chunkを新規吹き出しにする。
    case 'stream.bubble_break':
      return {
        ...base,
      };

    case 'stream.delta': {
      const message = {
        ...base,
        textDelta: String(coreEvent.textDelta || ''),
      };

      // ツール呼出前の固定セリフ（つなぎの発話）であることを示す。
      // クライアントは通常の発話として表示してよいが、
      // 履歴へ残さない等の判断に使える。
      if (coreEvent.isFiller) {
        message.isFiller = true;
      }

      return message;
    }

    case 'stream.completed': {
      const message = {
        ...base,
        text: String(coreEvent.text || ''),
        // 後方互換フィールド。既存Flutter/Unity実装はここだけ見ていても動く。
        emotion: String(coreEvent.emotion || 'neutral'),
        intensity: typeof coreEvent.intensity === 'number'
          ? coreEvent.intensity
          : 0.5,
      };

      // v13: 12感情の比率Map + 全体強度。
      // Unity BlendShape 重み = emotions[key] × overall_intensity
      // Core側が未対応の場合はフィールドごと省略し、旧クライアントを壊さない。
      if (coreEvent.emotions && typeof coreEvent.emotions === 'object') {
        message.emotions = coreEvent.emotions;
      }

      if (typeof coreEvent.overall_intensity === 'number') {
        message.overall_intensity = coreEvent.overall_intensity;
      }

      return message;
    }

    // ツール実行中の通知。
    // クライアントは「調べています…」のようなUIを出すために使う。
    case 'stream.tool':
      return {
        ...base,
        tool: String(coreEvent.tool || ''),
        description: String(coreEvent.description || ''),
        estimatedSeconds: typeof coreEvent.estimatedSeconds === 'number'
          ? coreEvent.estimatedSeconds
          : 3,
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
