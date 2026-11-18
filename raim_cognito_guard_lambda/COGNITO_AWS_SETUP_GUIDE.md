# Cognitoアカウント統合 AWS側手順書（実装予定構成）

## 1. 目的

標準ユーザーとGoogleユーザーのどちらを先に作成しても、最終的に1件の標準CognitoユーザーへGoogle identityをリンクする。

```text
標準Cognitoユーザー
 ├─ メールアドレス・パスワード
 └─ Google identity
```

同じメールアドレスだけで自動統合せず、Googleの検証済み属性、Googleの`sub`、既存ユーザーの状態を確認してから、バックエンドLambdaがリンクする。

本書はこれから実装する目標構成を記載する。リポジトリに未実装のLambdaがある場合は、手順に従って新規作成する。

## 2. Lambda構成

| Lambda | 種別 | 用途 |
|---|---|---|
| `RAiM_CognitoGuard_Lambda_dev` | Pre sign-up | 外部IdPの新規登録制御、重複する標準登録の拒否 |
| `RAiM_CognitoFederation_Lambda_dev` | Inbound federation | 標準ユーザー先行時のGoogle identityリンク |
| `RAiM_CognitoAccountLink_Lambda_dev` | API Gateway | Google先行時に標準ユーザーを作成し、Google identityをリンク |
| `RAiM_CognitoInitialPassword_Lambda_dev` | API Gateway | ログイン済みユーザーのメニューからのパスワード変更 |

Account Link Lambdaは今回の目標構成に含める。Google先行時の初回パスワード設定もAccount Link Lambdaで行う。Initial Password Lambdaは、ログイン後の設定メニューから、認証済みユーザー自身がパスワードを変更するためだけに使用する。

## 3. 認証フロー

### 3.1 標準ユーザー先行

```text
標準ユーザー登録
  ↓
Google初回ログイン
  ↓
Inbound federation Lambda
  ↓
Googleのsub・検証済みメールと既存標準ユーザーを確認
  ↓
AdminLinkProviderForUser
  ↓
同じ標準ユーザーでGoogle・パスワードログイン
```

リンク条件を満たさない場合は自動リンクせず、サポートまたは管理者移行へ誘導する。

### 3.2 Googleユーザー先行

```text
Google初回ログイン
  ↓
Googleフェデレーションプロフィール作成
  ↓
認証済みクライアントがPOST /account/link
  ↓
Account Link Lambda
  ↓
標準ユーザー作成または既存標準ユーザーの確認
  ↓
標準ユーザーへパスワード設定
  ↓
既存フェデレーションプロフィールを整理
  ↓
AdminLinkProviderForUser
  ↓
再ログイン
```

Google先行時は、アクセストークンから対象Googleユーザーを特定する。クライアントから任意のUsername、sub、メールアドレスを受け取って対象ユーザーを決めない。

## 4. ZIPとHandler

各Lambdaは、AWS LambdaコンソールへアップロードするZIPのルート直下に`index.js`を置く。

```text
raim_cognito_guard_lambda/function.zip
└─ index.js

raim_cognito_federation_lambda/function.zip
└─ index.js

raim_cognito_account_link_lambda/function.zip
├─ index.js
├─ package.json
├─ package-lock.json
└─ node_modules/

raim_cognito_initial_password_lambda/function.zip
├─ index.js
├─ package.json
├─ package-lock.json
└─ node_modules/
```

Handlerはすべて次の形式とする。

```text
index.handler
```

## 5. IAM実行ロール

Lambdaごとに実行ロールを分離する。

| Lambda | 必要なCognito権限 |
|---|---|
| Guard | `cognito-idp:ListUsers` |
| Federation | `cognito-idp:ListUsers`、`cognito-idp:AdminLinkProviderForUser` |
| Account Link | `AdminGetUser`、`ListUsers`、`AdminCreateUser`、`AdminSetUserPassword`、`AdminLinkProviderForUser`、必要な場合のみ`AdminDeleteUser` |
| Initial Password | Cognito管理API権限不要（`ChangePassword`を使用） |

全ロールのResourceは対象User Pool ARNに限定する。

```text
arn:aws:cognito-idp:ap-northeast-1:990442281360:userpool/ap-northeast-1_OMFV9fgsG
```

Account Link Lambdaの`AdminDeleteUser`は一般ユーザーを任意に削除するための権限ではない。Googleログイン済みプロフィールをリンクする際、AWS公式手順上削除が必要になる場合に限り、アクセストークンから特定した対象プロフィールへ使用する。Usernameをリクエストで受け取らず、Googleの`sub`・メール検証・対象User Poolを再確認する。

管理者による重複ユーザー移行やデータ移行は、Account Link Lambdaと別の管理者専用ロール・処理に分離する。通常のCognitoトリガーや公開APIへ`AdminDeleteUser`を付与しない。

## 6. Google IdPとUser Pool

次を設定する。

- Google IdPを有効化する
- `email`をGoogleの`email`へマッピングする
- `email_verified`をGoogleの`email_verified`へマッピングする
- `name`は必要な場合だけマッピングする
- `username -> sub`の手動マッピングは行わない
- メールアドレスをサインイン属性として有効化する
- 対象App Clientで`COGNITO`と`Google`を有効化する

CognitoはIdPと外部`sub`をもとにフェデレーションユーザー名を生成する。リンクではGoogleの`sub`を`Cognito_Subject`として指定する。

## 7. Cognitoトリガー

User PoolのLambda triggersで次を設定する。

```text
Pre sign-up:
  RAiM_CognitoGuard_Lambda_dev

Inbound federation:
  RAiM_CognitoFederation_Lambda_dev
```

Lambdaを作成しただけではトリガーにならない。User Poolへ接続して保存し、コンソールテストとCloudWatch Logsで確認する。

### Guard環境変数

```text
PRESIGNUP_EXTERNAL_PROVIDER_BLOCK_ENABLED=false
BLOCK_NATIVE_SIGNUP_FOR_FEDERATED_EMAIL_ENABLED=true
```

- `PreSignUp_ExternalProvider`: 外部IdPの新規登録を許可・拒否
- `PreSignUp_SignUp`: 同じメールアドレスのGoogle identityがある場合、標準登録を拒否
- その他: イベントをそのまま返す

## 8. Federation Lambdaのリンク条件

次をすべて満たす場合だけ`AdminLinkProviderForUser`を実行する。

- `providerName`が`Google`
- Googleの`sub`、`email`が存在する
- Googleの`email_verified=true`
- 既存標準ユーザーのメールアドレスが検証済み
- 正規化後のメールアドレスが完全一致する
- 未リンクの標準ユーザーが1件だけ存在する
- Googleの`sub`が別ユーザーへリンクされていない

```text
DestinationUser.ProviderName           = Cognito
DestinationUser.ProviderAttributeValue = 標準ユーザーのUsername

SourceUser.ProviderName                = Google
SourceUser.ProviderAttributeName       = Cognito_Subject
SourceUser.ProviderAttributeValue      = Googleのsub
```

複数一致、未検証、競合、AWS APIエラーの場合は自動リンクしない。メールアドレス一致だけでリンクしない。

## 9. Account Link LambdaのAPI

API Gatewayに次を作成する。

```text
POST /account/link
統合: Lambda proxy
Lambda: RAiM_CognitoAccountLink_Lambda_dev
認可: raim-cognito-authorizer
APIキー: 不要
```

LambdaはAPI Gatewayの認可だけに依存せず、アクセストークンを自分でも検証する。

環境変数:

```text
COGNITO_USER_POOL_ID=ap-northeast-1_OMFV9fgsG
COGNITO_APP_CLIENT_ID=<対象App Client ID>
ACCOUNT_LINK_MAX_AUTH_AGE_SECONDS=900
```

1. Bearerアクセストークンの署名、発行元、App Client、`token_use=access`を確認する
2. `sub`、`auth_time`、対象User Poolを確認する
3. トークンのユーザーがGoogle identityを持つことを確認する
4. Googleの`email_verified=true`とメールアドレスを確認する
5. 同じメールアドレスの標準ユーザーが複数ないことを確認する
6. 必要な場合は`AdminCreateUser(MessageAction=SUPPRESS)`で標準ユーザーを作成する
7. `AdminSetUserPassword(Permanent=true)`で標準ユーザーへパスワードを設定する
8. 既存フェデレーションプロフィールを整理する
9. `AdminLinkProviderForUser`でGoogleの`sub`を標準ユーザーへリンクする
10. 成功後はクライアントへ再ログインを要求する

リクエスト例:

```json
{
  "proposedPassword": "新しいパスワード"
}
```

`AdminCreateUser`で一時パスワードを指定すると`FORCE_CHANGE_PASSWORD`になるため、歓迎メールを送らない場合は`MessageAction=SUPPRESS`を使用し、作成後に永続パスワードを設定する。

### 失敗時の扱い

ユーザー作成、パスワード設定、既存プロフィール整理、リンクは単一トランザクションではない。次を実装仕様にする。

- 各段階を監査ログへ記録する
- リクエストIDと対象Cognito`sub`で冪等性を確認する
- 途中失敗時に自動で別ユーザーを作らない
- 既に作成した標準ユーザーを無条件に削除しない
- リンク前に保存した情報を使って管理者が復旧できる状態にする
- 成功済み状態を再実行した場合は既存ユーザーを再作成せず、確認して成功扱いにする
- パスワード・アクセストークン・Google ID tokenをログへ出力しない

## 10. Initial Password Lambda

このLambdaは、ログイン後の設定メニューからパスワードを変更するためだけのAPIとする。Googleユーザーの初回パスワード設定や、別ユーザーのパスワード設定には使用しない。

```text
POST /account/password
統合: Lambda proxy
Lambda: RAiM_CognitoInitialPassword_Lambda_dev
認可: raim-cognito-authorizer
APIキー: 不要
```

環境変数:

```text
COGNITO_USER_POOL_ID=ap-northeast-1_OMFV9fgsG
COGNITO_APP_CLIENT_ID=<対象App Client ID>
```

リクエスト例:

```json
{
  "previousPassword": "現在のパスワード",
  "proposedPassword": "新しいパスワード"
}
```

LambdaはBearerアクセストークン、現在のパスワード、新しいパスワードを受け取り、Cognitoの`ChangePassword`を実行する。対象ユーザーはアクセストークンから決まり、Usernameやsubをリクエストボディから受け取らない。`AdminSetUserPassword`は使用しない。`ChangePassword`では、パスワードを持つユーザーの現在のパスワードが必要になる。

App Clientでは`aws.cognito.signin.user.admin`スコープを許可し、クライアントがそのスコープを要求する。API GatewayのUser Pool Authorizerだけに依存せず、Lambdaでもアクセストークンの署名、発行元、App Client、`token_use=access`を検証する。

## 11. 既存Googleユーザーのみを手動統合する手順

この手順は、既にGoogleユーザーだけが存在し、同じメールアドレスの標準ユーザーが存在しない場合に使用する。通常の新規ユーザーはAccount Link Lambdaを使用し、本手順は既存ユーザーの救済・管理者移行に限定する。

### 11.1 実施前の確認

- 対象ユーザー本人の確認を行う
- 対象メールアドレスが本人の管理下にあることを確認する
- GoogleユーザーのUsername、Cognitoの`sub`、Googleの`identities.userId`を確認する
- `identities`の`providerName`が`Google`であることを確認する
- アプリデータをバックアップする
- アプリデータが旧GoogleユーザーのCognito `sub`に紐付く場合は、移行方針を決める
- 同じメールアドレスの標準ユーザーが存在しないことを確認する

確認した値をPowerShell変数に設定する。`$cognitoSub`は記録・照合用、リンクコマンドには`$googleSub`を使う。コンソールでユーザーを作る場合は、フォームへ同じ変数値を転記する。

```powershell
$userPoolId = "ap-northeast-1_OMFV9fgsG"
$email = "対象ユーザーのメールアドレス"
$googleSub = "identities.userIdの値"
$googleUsername = "google_$googleSub"
$cognitoSub = "GoogleユーザーのCognito sub"
$standardUsername = $email
$password = "ここに設定するパスワード"
```

表示例の形式に合わせ、`$googleUsername`は`google_`と`$googleSub`を連結して作る。実行前にCognitoコンソールに表示されたUsernameと一致することを必ず確認する。`$password`には使用するパスワードを直接記入し、一時パスワードと正式パスワードの両方に使う。この値はPowerShellの履歴やメモリに残る可能性があるため、共有端末では実施せず、設定行を保存・共有せず、作業後に`Remove-Variable password`を実行する。

### 11.2 Cognitoコンソールで標準ユーザーを作成

1. Cognitoコンソールで対象User Poolの「ユーザー」を開く
2. 対象Googleユーザーの属性を記録する
3. 「ユーザーを作成」を選択する
4. Usernameに`$standardUsername`の値を入力する
5. `$email`の値をメールアドレスに設定する
6. `email_verified=true`にする
7. 招待メールを送信しない設定にする
8. `$password`に入力した値を一時パスワードに設定して作成する

同じメールアドレスがGoogleユーザーのエイリアスとして使用されているため、コンソールでエイリアス重複エラーになる場合がある。その場合は、以下のCLIで`--force-alias-creation`を指定して標準ユーザーを作成する。

```powershell
aws cognito-idp admin-create-user --user-pool-id $userPoolId --username $standardUsername --user-attributes "Name=email,Value=$email" "Name=email_verified,Value=true" --message-action SUPPRESS --force-alias-creation --temporary-password $password
```

### 11.3 標準ユーザーへ永続パスワードを設定

標準ユーザーの作成後、`AdminSetUserPassword`で永続パスワードを設定する。

```powershell
aws cognito-idp admin-set-user-password --user-pool-id $userPoolId --username $standardUsername --password $password --permanent
```

コンソールで標準ユーザーの状態が以下になっていることを確認する。

```text
UserStatus: CONFIRMED
email_verified: true
identities: なし
```

### 11.4 Googleプロフィールを削除

既にGoogleログイン済みのフェデレーションプロフィールは、リンク前に削除が必要になる。

削除前に、次の情報とアプリデータを保存する。

```text
GoogleユーザーのUsername
GoogleユーザーのCognito sub
Googleのsub（identities.userId）
メールアドレス
アプリデータ
```

削除対象がGoogleユーザーであることを再確認してから、以下を実行する。

```powershell
aws cognito-idp admin-delete-user --user-pool-id $userPoolId --username $googleUsername
```

この操作は破壊的である。標準ユーザーを削除しない。削除後にリンクが失敗した場合は、別のユーザーを作成せず、管理者へ復旧を依頼する。

### 11.5 Google identityを標準ユーザーへリンク

```powershell
aws cognito-idp admin-link-provider-for-user --user-pool-id $userPoolId --destination-user "ProviderName=Cognito,ProviderAttributeValue=$standardUsername" --source-user "ProviderName=Google,ProviderAttributeName=Cognito_Subject,ProviderAttributeValue=$googleSub"
```

`ProviderAttributeValue`にはCognitoの`sub`ではなく、Googleの`identities.userId`を指定する。

### 11.6 完了確認

Cognitoコンソールで以下を確認する。

- 同じメールアドレスのユーザーが1件だけ存在する
- Usernameが標準ユーザーのものになっている
- UserStatusが`CONFIRMED`
- `email_verified=true`
- `identities`に`providerName=Google`が存在する
- `identities.userId`が元のGoogleの`sub`と一致する

その後、以下を確認する。

1. Googleログイン
2. ログアウト
3. メールアドレス・パスワードログイン
4. 両方で同じアプリユーザーとデータが表示されること

認証は統合されても、アプリデータの主キーが旧Cognito `sub`の場合は、標準ユーザーの`sub`へデータ移行が必要になる。

コマンド作業が終わったら、パスワード変数を消去する。

```powershell
Remove-Variable password
```

## 12. 既存重複ユーザーの移行

標準ユーザーとGoogleユーザーが既に別々に存在する場合、公開APIから自動削除・自動統合しない。

管理者専用の移行処理で次を行う。

1. 本人確認を行う
2. 両ユーザーのUsername、Cognitoの`sub`、Googleの`sub`を記録する
3. アプリデータと属性をバックアップする
4. 正規ユーザーを決定する
5. アプリデータを正規ユーザーへ移行する
6. AWS公式手順に従い、必要な属性を保存してから不要プロフィールを整理する
7. `AdminLinkProviderForUser`でリンクする
8. Google・パスワードログインとアプリデータを確認する
9. 移行記録を保存する

## 13. 同時実行と整合性

`ListUsers`はEventually Consistentであるため、検索結果が一時的に最新でない場合がある。ロックや予約を実装しない場合、「同時実行でも重複しない」とは保証しない。

最低限、次を行う。

- 一意に判定できない場合は自動リンクしない
- 同じ対象に対する処理の再実行を冪等にする
- AWS APIエラー時は成功扱いにしない
- 競合は監査ログ・メトリクスで検知する
- 重複発生時は管理者専用移行で解消する

## 14. テスト

- Guard: 外部IdP新規登録のOn/Off
- Guard: Googleユーザーなしの標準登録
- Guard: Googleユーザーと同じメールの標準登録拒否
- Federation: 標準ユーザー先行でリンク
- Federation: `email_verified=false`、複数一致、別Google`sub`で拒否
- Account Link: Google認証済みトークンで標準ユーザーを作成・リンク
- Account Link: 同じリクエストの再実行が冪等
- Account Link: Usernameやsubの差し替えを拒否
- Account Link: 途中失敗後に別ユーザーを重複作成しない
- Initial Password: ログイン済みユーザーが設定メニューからパスワードを変更できる
- Initial Password: 未認証・期限切れ・別App Clientのトークンを拒否する
- Initial Password: Usernameやsubの差し替えを拒否する
- 全API: 未認証、期限切れ、別App Clientのトークンを拒否
- 全API: パスワード・トークン・AWS認証情報がログに出ない
- API Gateway: 認可、ステージデプロイ、HTTPS、レート制限

## 15. 参照

- [Cognitoユーザーの統合](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation-consolidate-users.html)
- [AdminLinkProviderForUser](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminLinkProviderForUser.html)
- [AdminCreateUser](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminCreateUser.html)
- [AdminSetUserPassword](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminSetUserPassword.html)
- [ChangePassword](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_ChangePassword.html)
- [ListUsers](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_ListUsers.html)
- [属性マッピング](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-specifying-attribute-mapping.html)
