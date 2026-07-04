#!/usr/bin/env node

/**
 * Cognito Access Token取得テスト（Node.js版）
 *
 * Python版 cognito_token_test.py と同じAuthorization Code + PKCEフローで、
 * Cognito Managed LoginからAccess Tokenを取得するためのローカル検証プログラムです。
 *
 * 実行方法:
 *   node cognito_token_test.js
 *
 * PowerShellの環境変数へAccess Tokenを直接格納する場合:
 *   $env:ACCESS_TOKEN = node .\cognito_token_test.js --token-only
 *
 * Access Token取得後、CloudFrontへ接続してメッセージを1件送信する場合:
 *   node .\cognito_token_test.js --wscat --text "こんにちは"
 *
 * 接続先や応答待機時間を指定する場合:
 *   node .\cognito_token_test.js --wscat --text "こんにちは" `
 *     --endpoint "wss://example.cloudfront.net/dev" --wait 120
 *
 * --token-onlyでは、Access Tokenだけを標準出力へ出す。
 * ログインURLや入力案内は標準エラー出力へ分けるため、PowerShell変数には混ざらない。
 *
 * 前提:
 *   - Node.js 18以上（標準のfetch APIを使用）
 *   - Cognito App Clientに次のCallback URLが登録されていること
 *       http://localhost:3000/callback
 *   - Cognito App ClientにClient Secretが設定されていないこと
 *
 * 処理の流れ:
 *   1. PKCE用のcode_verifierとcode_challengeを生成する
 *   2. Cognito Managed Loginをブラウザで開く
 *   3. ログイン後のリダイレクトURLをユーザーが貼り付ける
 *   4. URL内のAuthorization CodeをToken endpointへ送る
 *   5. WebSocket認証に使用するAccess Tokenだけを表示する
 *   6. --wscat指定時は、TokenをAuthorizationヘッダーへ設定してCloudFrontへ接続する
 *   7. RAiM形式のユーザーリクエストを送信し、ストリーミング応答を表示する
 *
 * 注意:
 *   このプログラムは接続試験用のためAccess Tokenを画面へ表示します。
 *   表示されたTokenを共有したり、Gitやログファイルへ保存したりしないでください。
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline/promises');
const { stdin, stdout, stderr } = require('node:process');

// 環境変数を指定しない場合は、Python版と同じRAiM開発環境の値を使用する。
const COGNITO_DOMAIN = String(
  process.env.COGNITO_DOMAIN ||
  'https://ap-northeast-1omfv9fgsg.auth.ap-northeast-1.amazoncognito.com'
).replace(/\/$/, '');

const APP_CLIENT_ID = String(
  process.env.COGNITO_CLIENT_ID || '3s1n1qe8vlsihh2j2dlcs4ecf5'
);

const CALLBACK_URL = String(
  process.env.COGNITO_CALLBACK_URL || 'http://localhost:3000/callback'
);

// CloudFront経由でWebSocket APIへ接続する。
// 環境ごとにDistributionが異なる場合はRAIM_WEBSOCKET_URLまたは--endpointで上書きする。
const DEFAULT_WEBSOCKET_URL = String(
  process.env.RAIM_WEBSOCKET_URL ||
  'wss://d1403ont6098ah.cloudfront.net/dev'
);

// CloudFront/WAFがクライアント種別を確認できるよう、検証時もFlutterと同じ値を送る。
const DEFAULT_USER_AGENT = String(
  process.env.RAIM_USER_AGENT || 'RAiM-Flutter/1.0'
);

const DEFAULT_WSCAT_WAIT_SECONDS = 60;

/**
 * コマンドラインオプションを読み取る。
 *
 * tokenOnly=trueの場合は、PowerShellが標準出力をそのまま環境変数へ代入できるよう、
 * Access Token以外を標準出力へ書かない。
 */
function parseOptions(argv) {
  const args = argv.slice(2);
  const options = {
    tokenOnly: false,
    useWscat: false,
    text: '',
    endpoint: DEFAULT_WEBSOCKET_URL,
    waitSeconds: DEFAULT_WSCAT_WAIT_SECONDS,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case '--token-only':
        options.tokenOnly = true;
        break;
      case '--wscat':
        options.useWscat = true;
        break;
      case '--text':
        options.text = readOptionValue(args, ++index, '--text');
        break;
      case '--endpoint':
        options.endpoint = readOptionValue(args, ++index, '--endpoint');
        break;
      case '--wait': {
        const rawWait = readOptionValue(args, ++index, '--wait');
        const waitSeconds = Number(rawWait);

        if (!Number.isInteger(waitSeconds) || waitSeconds < -1) {
          throw new Error('--wait must be an integer greater than or equal to -1');
        }

        options.waitSeconds = waitSeconds;
        break;
      }
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.tokenOnly && options.useWscat) {
    throw new Error('--token-only and --wscat cannot be used together');
  }

  if ((options.text || options.endpoint !== DEFAULT_WEBSOCKET_URL ||
      options.waitSeconds !== DEFAULT_WSCAT_WAIT_SECONDS) && !options.useWscat) {
    throw new Error('--text, --endpoint and --wait require --wscat');
  }

  validateWebSocketUrl(options.endpoint);
  return options;
}

/**
 * 値を必要とするコマンドラインオプションの次の引数を読む。
 * 未指定や次のオプション名を誤って値として渡した場合は、ログイン開始前に終了する。
 */
function readOptionValue(args, index, optionName) {
  const value = args[index];

  if (value === undefined || String(value).startsWith('--')) {
    throw new Error(`${optionName} requires a value`);
  }

  return String(value).trim();
}

/** CloudFront WebSocket接続先として、安全なwss URLだけを許可する。 */
function validateWebSocketUrl(value) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`WebSocket endpoint is not a valid URL: ${error.message}`);
  }

  if (parsed.protocol !== 'wss:') {
    throw new Error('WebSocket endpoint must use wss://');
  }
}

function printUsage() {
  console.log(`Usage:
  node cognito_token_test.js
  node cognito_token_test.js --token-only
  node cognito_token_test.js --wscat [--text <message>] [--endpoint <wss-url>] [--wait <seconds>]

Options:
  --token-only       Access Tokenだけを標準出力へ出す
  --wscat            Token取得後にCloudFrontへ接続してリクエストを送る
  --text <message>   送信する本文。省略時は対話入力する
  --endpoint <url>   CloudFrontのwss URL
  --wait <seconds>   送信後に応答を待つ秒数。既定値60、-1は手動終了まで待機
  --help, -h         この説明を表示する`);
}

/**
 * PKCEのcode_verifierを生成する。
 *
 * 48バイトの乱数をBase64 URL形式へ変換すると、PKCEで利用可能な64文字になる。
 * 暗号学的に安全なcrypto.randomBytes()を使い、推測困難な値にする。
 */
function generateCodeVerifier() {
  return crypto.randomBytes(48).toString('base64url');
}

/**
 * code_verifierをSHA-256でハッシュし、Base64 URL形式のcode_challengeへ変換する。
 * Node.jsのbase64urlは、URLで問題になる「+」「/」「=」を含まない形式を返す。
 */
function generateCodeChallenge(codeVerifier) {
  return crypto
    .createHash('sha256')
    .update(codeVerifier, 'ascii')
    .digest('base64url');
}

/**
 * OSの既定ブラウザでCognito Managed Loginを開く。
 * ブラウザの自動起動に失敗しても、表示したURLを手動で開けばテストを続行できる。
 */
function openBrowser(url) {
  let command;
  let args;

  if (process.platform === 'win32') {
    // cmd.exeのstartへURLを渡すと「&」がコマンド区切りとして解釈され得るため、
    // Windows Shellに直接URLを渡せるexplorer.exeを使用する。
    command = 'explorer.exe';
    args = [url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });

    child.on('error', () => {
      // URLはコンソールにも表示しているため、ブラウザ起動失敗だけでは終了しない。
    });
    child.unref();
  } catch {
    // 手動でURLを開けるよう、ここでは処理を継続する。
  }
}

/**
 * リダイレクトURLからAuthorization Codeを取り出す。
 * Cognitoがerrorを返した場合は、Token endpointへ進まず原因を表示する。
 */
function extractAuthorizationCode(redirectedUrl) {
  let parsed;

  try {
    parsed = new URL(redirectedUrl);
  } catch (error) {
    throw new Error(`貼り付けた値は有効なURLではありません: ${error.message}`);
  }

  const cognitoError = parsed.searchParams.get('error');
  if (cognitoError) {
    const description = parsed.searchParams.get('error_description');
    throw new Error(
      `Cognito login failed: ${cognitoError}` +
      (description ? ` (${description})` : '')
    );
  }

  const code = parsed.searchParams.get('code');
  if (!code) {
    throw new Error('code が見つかりません。リダイレクト後のURLを確認してください。');
  }

  return code;
}

/**
 * Authorization Codeとcode_verifierをCognito Token endpointへ送り、Tokenへ交換する。
 */
async function exchangeCodeForTokens(code, codeVerifier) {
  const tokenUrl = `${COGNITO_DOMAIN}/oauth2/token`;
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: APP_CLIENT_ID,
    code,
    redirect_uri: CALLBACK_URL,
    code_verifier: codeVerifier,
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  const responseText = await response.text();
  let payload;

  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    payload = null;
  }

  return {
    status: response.status,
    ok: response.ok,
    payload,
    responseText,
  };
}

/**
 * npmでグローバルインストールされたwscat本体のJavaScriptを探す。
 * PowerShellではwscat.ps1が実行ポリシーに遮断されることがあるため、
 * ラッパーではなくbin/wscatをNode.jsで直接起動する。
 */
function resolveWscatCli() {
  const candidates = [
    process.env.WSCAT_CLI_PATH,
    process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'wscat', 'bin', 'wscat')
      : '',
    process.env.npm_config_prefix
      ? path.join(process.env.npm_config_prefix, 'node_modules', 'wscat', 'bin', 'wscat')
      : '',
  ].filter(Boolean);

  const cliPath = candidates.find((candidate) => fs.existsSync(candidate));

  if (!cliPath) {
    throw new Error(
      'wscat was not found. Install it with: npm install -g wscat'
    );
  }

  return cliPath;
}

/** 送信本文が--textで指定されなかった場合に、コンソールから入力する。 */
async function askUserText() {
  const terminal = readline.createInterface({ input: stdin, output: stdout });

  try {
    return String(await terminal.question('RAiMへ送信するメッセージ: ')).trim();
  } finally {
    terminal.close();
  }
}

/**
 * Access TokenをAuthorizationヘッダーへ設定してwscatを起動する。
 *
 * --executeで接続直後にRAiM形式のJSONを1件送り、--waitで指定した時間だけ
 * 接続を維持する。Core Lambdaからのstream.start/delta/completedは、wscatの
 * 標準出力へ到着順に表示される。
 */
async function runWscat({ accessToken, endpoint, text, waitSeconds }) {
  const wscatCli = resolveWscatCli();
  const request = {
    requestId: `local-${crypto.randomUUID()}`,
    text,
    images: [],
  };
  const requestJson = JSON.stringify(request);
  const args = [
    wscatCli,
    '--connect', endpoint,
    '--header', `Authorization: Bearer ${accessToken}`,
    '--header', `User-Agent: ${DEFAULT_USER_AGENT}`,
    '--execute', requestJson,
    '--wait', String(waitSeconds),
    '--no-color',
  ];

  console.log();
  console.log('=== CloudFront WebSocket Test ===');
  console.log(`Endpoint  : ${endpoint}`);
  console.log(`User-Agent: ${DEFAULT_USER_AGENT}`);
  console.log(`Request ID: ${request.requestId}`);
  console.log(`Text      : ${text}`);
  console.log(`Wait      : ${waitSeconds === -1 ? 'until Ctrl+C' : `${waitSeconds} seconds`}`);
  console.log('Access TokenはAuthorizationヘッダーへ設定します（画面には表示しません）。');
  console.log();

  await new Promise((resolve, reject) => {
    // wscatのJavaScript本体を現在のNode.jsで直接実行するため、
    // PowerShellのスクリプト実行ポリシーには影響されない。
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      windowsHide: false,
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(
        signal
          ? `wscat was terminated by signal ${signal}`
          : `wscat exited with code ${code}`
      ));
    });
  });
}

async function main() {
  const options = parseOptions(process.argv);

  if (options.help) {
    printUsage();
    return;
  }

  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  // --token-onlyでは案内をstderrへ出し、stdoutをAccess Token専用にする。
  // 通常実行では、従来どおりすべての案内を標準出力へ表示する。
  const printInformation = (...values) => {
    if (options.tokenOnly) {
      console.error(...values);
    } else {
      console.log(...values);
    }
  };

  const authUrl = new URL(`${COGNITO_DOMAIN}/login`);
  authUrl.search = new URLSearchParams({
    client_id: APP_CLIENT_ID,
    response_type: 'code',
    scope: 'email openid phone',
    redirect_uri: CALLBACK_URL,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();

  printInformation('=== Cognito Access Token Test ===');
  printInformation(`Cognito domain : ${COGNITO_DOMAIN}`);
  printInformation(`App client ID  : ${APP_CLIENT_ID}`);
  printInformation(`Callback URL   : ${CALLBACK_URL}`);
  printInformation();
  printInformation('=== Open this URL ===');
  printInformation(authUrl.toString());
  printInformation();
  printInformation('code_verifier:');
  printInformation(codeVerifier);
  printInformation();
  printInformation('ブラウザでログインしてください。');
  printInformation('localhostへの接続エラー画面になっても、アドレスバーのURLをコピーできます。');
  printInformation();

  openBrowser(authUrl.toString());

  const terminal = readline.createInterface({
    input: stdin,
    // token-only時も入力プロンプトを画面へ表示しつつ、stdoutには混ぜない。
    output: options.tokenOnly ? stderr : stdout,
  });
  let redirectedUrl;

  try {
    redirectedUrl = String(
      await terminal.question('ログイン後に表示されたURLを貼ってください: ')
    ).trim();
  } finally {
    terminal.close();
  }

  const code = extractAuthorizationCode(redirectedUrl);
  const result = await exchangeCodeForTokens(code, codeVerifier);

  if (!result.ok) {
    // 失敗時だけ、Tokenを含まないCognitoのエラー応答を調査用に表示する。
    console.error();
    console.error('=== Token endpoint error ===');
    console.error(`status: ${result.status}`);
    console.error(result.payload
      ? JSON.stringify(result.payload, null, 2)
      : result.responseText);
    throw new Error(`Token endpoint failed with HTTP ${result.status}`);
  }

  if (!result.payload?.access_token) {
    throw new Error('Token endpoint response does not contain access_token');
  }

  // 取得したTokenを後続処理から参照しやすい名前の変数へ格納する。
  // この変数は現在のNode.jsプロセス内だけで有効であり、PowerShellの環境変数とは別物。
  const accessToken = String(result.payload.access_token);

  if (options.tokenOnly) {
    // PowerShellの代入対象になるstdoutにはAccess Tokenの1行だけを出力する。
    stdout.write(`${accessToken}\n`);
    return;
  }

  if (options.useWscat) {
    const userText = options.text || await askUserText();

    if (!userText) {
      throw new Error('User message must not be empty');
    }

    await runWscat({
      accessToken,
      endpoint: options.endpoint,
      text: userText,
      waitSeconds: options.waitSeconds,
    });
    return;
  }

  console.log();
  console.log('=== Access Token ===');
  console.log(accessToken);
  console.log();
  console.log('変数名: accessToken');
}

main().catch((error) => {
  console.error();
  console.error('ERROR');
  console.error(`  ${error.message}`);
  process.exitCode = 1;
});
