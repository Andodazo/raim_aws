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
// 6. DynamoDB の Scene / Few-shot 定義を取得する
// 7. Titanなしの仮実装として、キーワードベースでSceneを選択する
// 8. prompt-builder.js でMantleへ渡すinputを組み立てる
// 9. 現時点では Mantle にはまだアクセスせず、debug情報を返す
//
// 今後追加する予定:
// - Mantle Clientの実装
// - Mantle Responses API 呼び出し
// - Mantleから返った response_id のDynamoDB保存
// - Mantle返答の正規化
// - 本番向けにdebugを削除
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

const {
  listScenes,
  summarizeScenes,
} = require('./lib/scene-repository');

const {
  selectScene,
  summarizeSceneSelection,
} = require('./lib/scene-selector');

const {
  buildMantleInput,
  summarizeMantleInput,
} = require('./lib/prompt-builder');

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
// scene-repository.js で Scene / Few-shot 定義を取得
// ↓
// scene-selector.js で仮Scene選択
// ↓
// prompt-builder.js で Mantle input を構築
// ↓
// chat JSON + debug情報を返却
//
// Mantle本体にはまだアクセスしない。
// 次の段階で mantle-client.js を追加する。

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

    const userText = validation.message.text;
    const images = Array.isArray(validation.message.images)
      ? validation.message.images
      : [];

    // ─────────────────────────────────────────
    // 3. Cognito sub取得
    // ─────────────────────────────────────────
    //
    // sub はCognitoユーザーを一意に識別するID。
    // DynamoDB UserSessionテーブルのPartition Keyとして使う。

    const sub = getSubFromEvent(event);

    // ─────────────────────────────────────────
    // 4. UserSession取得/作成
    // ─────────────────────────────────────────
    //
    // RAiM-UserSession-dev から sub をキーにItemを取得する。
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
    // usePreviousResponseId が true の場合:
    //   prompt-builder.js は followup mode のinputを作る。
    //
    // usePreviousResponseId が false の場合:
    //   prompt-builder.js は initial mode のinputを作る。
    //   その際、固定プロンプト + sessionSummary + Scene + Few-shot を含める。

    const mantleSessionState = getMantleSessionState(session);

    // ─────────────────────────────────────────
    // 6. Scene / Few-shot 定義取得
    // ─────────────────────────────────────────
    //
    // RAiM-FewShot-dev からScene定義を読み取る。
    //
    // 今回の仕様では、画像Embeddingや画像Scene選択はしない。
    // Scene選択はユーザーの text をもとに行う。
    //
    // 現時点ではTitanがまだ使えないため、後続の scene-selector.js で
    // キーワードベースの仮Scene選択を行う。

    const scenes = await listScenes();
    const sceneSummary = summarizeScenes(scenes);

    // ─────────────────────────────────────────
    // 7. 仮Scene選択
    // ─────────────────────────────────────────
    //
    // 本来は Titan Text Embeddings V2 でユーザー発話をEmbeddingし、
    // 各Sceneの textCentroid と類似度比較してSceneを選択する。
    //
    // ただし、Bedrock / Titan連携は後回しにするため、
    // 今は scene-selector.js のキーワード判定で暫定的にSceneを選ぶ。
    //
    // 選ばれたSceneの few_shots は、後続の prompt-builder.js で
    // Mantleへ渡すプロンプト材料として使う。

    const sceneSelection = selectScene({
      userText,
      scenes,
    });

    const selectedSceneSummary = summarizeSceneSelection(sceneSelection);

    // ─────────────────────────────────────────
    // 8. Mantle input 組み立て
    // ─────────────────────────────────────────
    //
    // prompt-builder.js で、Mantleへ渡す入力構造を作る。
    //
    // response_id が使えない場合:
    //   mode: initial
    //   固定プロンプト、sessionSummary、Scene情報、Few-shot、今回の入力を含める。
    //
    // response_id が使える場合:
    //   mode: followup
    //   previous_response_id で会話をつなぐ前提なので、
    //   固定プロンプト全文やsessionSummaryは基本的に含めない。
    //
    // 画像がある場合:
    //   画像Embeddingは行わず、input_image としてMantleへ渡すための形に整える。
    //
    // この段階ではMantleへ送信せず、debugに概要だけ出す。
    // Base64画像やプロンプト全文をdebugに返すと大きすぎるため、
    // summarizeMantleInput() で件数やmodeだけを返す。

    const mantleInput = buildMantleInput({
      userText,
      images,
      sessionSummary: session.sessionSummary || '',
      scene: sceneSelection.scene,
      usePreviousResponseId: mantleSessionState.usePreviousResponseId,
    });

    const mantleInputSummary = summarizeMantleInput(mantleInput);

    // ─────────────────────────────────────────
    // 9. 現時点ではMantle未接続のため、確認用レスポンスを返す
    // ─────────────────────────────────────────
    //
    // 本来はこの後に以下を行う予定:
    // - mantle-clientでMantle Responses API呼び出し
    // - Mantle返答をnormalize
    // - response_idをDynamoDBへ保存
    //
    // 今は、UserSession / response_id判定 / Scene読み取り / Scene選択 /
    // Mantle input構築確認のため debug を返す。
    //
    // 本番ではdebugは返さない。

    return createResponse(200, {
      ...createChat({
        text: `入力チェックOK。Scene「${sceneSelection.sceneId}」でMantle inputを作成しました。text: ${userText}`,
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

        // Scene / Few-shot 読み取り確認
        sceneCount: scenes.length,
        scenes: sceneSummary,

        // 仮Scene選択結果
        selectedScene: selectedSceneSummary,

        // Mantle input 構築確認
        mantleInput: mantleInputSummary,
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
    // - DynamoDB UserSessionテーブルへのアクセスで例外
    // - DynamoDB Sceneテーブルへのアクセスで例外
    // - prompt-builder.js の実装エラー
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