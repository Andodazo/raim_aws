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
 *
 * 注意:
 *   このプログラムは接続試験用のためAccess Tokenを画面へ表示します。
 *   表示されたTokenを共有したり、Gitやログファイルへ保存したりしないでください。
 */

'use strict';

const crypto = require('node:crypto');
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

/**
 * コマンドラインオプションを読み取る。
 *
 * tokenOnly=trueの場合は、PowerShellが標準出力をそのまま環境変数へ代入できるよう、
 * Access Token以外を標準出力へ書かない。
 */
function parseOptions(argv) {
  const supportedOptions = new Set(['--token-only']);
  const args = argv.slice(2);

  for (const arg of args) {
    if (!supportedOptions.has(arg)) {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    tokenOnly: args.includes('--token-only'),
  };
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

async function main() {
  const options = parseOptions(process.argv);
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
