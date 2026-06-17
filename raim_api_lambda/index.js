'use strict';

// ==============================================================================
// RAiM API Lambda エントリポイント
// ==============================================================================
//
// 【このファイルの役割】
// CloudFront → API Gateway REST /chat → Lambda で呼び出される入口。
//
// 現在の主な処理:
// 1. API Gateway から渡された event.body を JSON として読み取る
// 2. types.js でリクエスト形式を検証する
// 3. Cognito Authorizer の claims からユーザー固有の sub を取得する
// 4. DynamoDB の UserSession を取得または作成する
// 5. Mantle の previous_response_id を使える状態か判定する
// 6. 現時点では Mantle にはまだアクセスせず、debug情報を返す
//
// 今後追加する予定:
// - Text Embedding
// - Scene選択
// - 固定プロンプト生成
// - Mantle Responses API 呼び出し
// - Mantleから返った response_id のDynamoDB保存
//
// ==============================================================================

const { getOrCreateUserSession } = require('./lib/user-session-store');

const {
  createChat,
  createError,
  ERROR_CODES,
  validateUpstream,
} = require('./lib/types');

const {
  getMantleSessionState,
} = require('./lib/mantle-session-policy');

// ─────────────────────────────────────────────
// Cognito sub 取得
// ─────────────────────────────────────────────
//
// API Gateway の Cognito Authorizer が認証に成功すると、
// event.requestContext.authorizer.claims にJWTのclaimsが入る。
//
// REST API Gateway の Cognito Authorizer の場合:
//   event.requestContext.authorizer.claims.sub
//
// HTTP API JWT Authorizer の場合:
//   event.requestContext.authorizer.jwt.claims.sub
//
// 今回はREST API Gateway構成だが、将来HTTP APIに変えても壊れにくいように
// 両方の形式を見ている。

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

// ─────────────────────────────────────────────
// リクエストBodyのパース
// ─────────────────────────────────────────────
//
// API Gateway Lambda Proxy Integration では、通常 event.body は文字列で渡される。
//
// 例:
//   event.body = "{\"text\":\"こんにちは\",\"images\":[]}"
//
// Lambda単体テストなどでは、bodyをオブジェクトで渡す可能性もあるため、
// object の場合はそのまま返す。
//
// JSON.parseに失敗した場合は null を返し、handler側で400エラーにする。

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

// ─────────────────────────────────────────────
// API Gateway向けレスポンス作成
// ─────────────────────────────────────────────
//
// Lambda Proxy Integration では、以下の形式で返す必要がある。
//
// {
//   statusCode: 200,
//   headers: {...},
//   body: "JSON文字列"
// }
//
// body はオブジェクトではなく JSON.stringify 済みの文字列にする。

function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',

      // PoC段階では全Origin許可。
      // 本番では必要に応じてFlutter/CloudFrontのOriginに絞る。
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}

// ─────────────────────────────────────────────
// Lambda Handler
// ─────────────────────────────────────────────
//
// 現時点の処理フロー:
//
// event受信
// ↓
// bodyをJSONとしてparse
// ↓
// validateUpstream() で { text, images } を検証
// ↓
// Cognito subを取得
// ↓
// DynamoDB UserSessionを取得/作成
// ↓
// mantle-session-policy.js で previous_response_id 利用可否を判定
// ↓
// chat JSON + debug情報を返却
//
// Mantle本体にはまだアクセスしない。
// 次の段階で mantle-client.js を追加して接続する。

exports.handler = async (event) => {
  console.log('event:', JSON.stringify(event));

  try {
    // ─────────────────────────────────────────
    // 1. body parse
    // ─────────────────────────────────────────
    //
    // 不正JSONの場合は null が返る。
    // その場合はクライアント側の入力不備として 400 を返す。

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

    // ─────────────────────────────────────────
    // 2. 入力バリデーション
    // ─────────────────────────────────────────
    //
    // validateUpstream() は lib/types.js 側で定義している。
    //
    // チェック内容:
    // - bodyがオブジェクトか
    // - textが文字列か
    // - text空 + images空 になっていないか
    // - imagesが配列か
    // - 画像の形式・枚数・サイズが制約内か
    //
    // 画像はEmbeddingには使わないが、Mantleへ渡す可能性があるため、
    // 形式チェックだけはここで行う。

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

    // ─────────────────────────────────────────
    // 3. Cognito sub取得
    // ─────────────────────────────────────────
    //
    // sub はCognitoユーザーを一意に識別するID。
    // DynamoDB UserSessionテーブルのPartition Keyとして使う。
    //
    // 例:
    //   sub = "57b4fa48-20b1-7057-072a-2c120dc03a7f"

    const sub = getSubFromEvent(event);

    // ─────────────────────────────────────────
    // 4. UserSession取得/作成
    // ─────────────────────────────────────────
    //
    // RAiM-UserSession-dev から sub をキーにItemを取得する。
    //
    // Itemがない場合:
    //   新規作成する。
    //
    // Itemがある場合:
    //   lastAccessedAt / updatedAt を更新する。
    //
    // Mantle構成では、ここで以下の情報を管理する。
    // - currentSessionId
    // - lastResponseId
    // - lastResponseCreatedAt
    // - lastResponseExpiresAt
    // - sessionSummary
    // - promptVersion

    const session = await getOrCreateUserSession(sub);

    // ─────────────────────────────────────────
    // 5. Mantle response_id 利用可否判定
    // ─────────────────────────────────────────
    //
    // Mantleの response_id はLambdaでは生成しない。
    // Mantleから返ってきた id / response_id をDynamoDBに保存し、
    // 次回以降 previous_response_id として使う。
    //
    // ここでは、保存済みの lastResponseId がまだ使えるかを判定する。
    //
    // 判定条件:
    // - lastResponseId が空ではない
    // - lastResponseExpiresAt が有効な日時
    // - lastResponseExpiresAt が現在時刻より未来
    //
    // response_id が使えない場合は、今後Mantle呼び出し時に
    // 固定プロンプト + sessionSummary + user text で新規会話を開始する。

    const mantleSessionState = getMantleSessionState(session);

    // ─────────────────────────────────────────
    // 6. 現時点ではMantle未接続のため、確認用レスポンスを返す
    // ─────────────────────────────────────────
    //
    // 本来はこの後に以下を行う予定:
    // - text embedding
    // - Scene選択
    // - prompt-builderでMantle input作成
    // - mantle-clientでMantle Responses API呼び出し
    // - Mantle返答をnormalize
    // - response_idをDynamoDBへ保存
    //
    // 今は、UserSessionとresponse_id判定の確認のためdebugを返す。
    // 本番ではdebugは返さない。

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

        // Mantle response_id 管理
        lastResponseId: mantleSessionState.lastResponseId,
        lastResponseCreatedAt: mantleSessionState.lastResponseCreatedAt,
        lastResponseExpiresAt: mantleSessionState.lastResponseExpiresAt,
        usePreviousResponseId: mantleSessionState.usePreviousResponseId,
        previousResponseId: mantleSessionState.previousResponseId,

        // response_id が使えないときにMantleへ渡す予定の復旧用情報
        hasSessionSummary: mantleSessionState.hasSessionSummary,
        promptVersion: session.promptVersion || '',
      },
    });
  } catch (error) {
    // ─────────────────────────────────────────
    // 例外処理
    // ─────────────────────────────────────────
    //
    // ここに来るのは、主に以下のようなケース。
    //
    // - Cognito sub が取得できない
    // - DynamoDBアクセスで例外
    // - 想定外の実装エラー
    //
    // createError() は NODE_ENV=production の場合、
    // details をレスポンスに含めない。
    //
    // PoC中はCloudWatch Logsにも詳細を出す。

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