# Cognitoアカウント統合設計書（実装予定構成）

## 1. 目的

標準ユーザーとGoogleユーザーのどちらを先に作成しても、最終的に1件の標準CognitoユーザーへGoogle identityをリンクする。

```text
標準Cognitoユーザー
 ├─ メールアドレス・パスワード
 └─ Google identity
```

メールアドレス一致だけでは統合せず、Googleの検証済み属性とGoogleの`sub`を検証したうえで、バックエンドだけが`AdminLinkProviderForUser`を実行する。

## 2. 採用方針

- 標準Cognitoユーザーを正規プロフィールとする
- Google先行時はAccount Link Lambdaで標準ユーザーを作成または特定し、Google identityをリンクする
- 標準先行時はInbound federation LambdaでGoogle identityをリンクする
- Guard Lambdaで、Google identityが存在するメールアドレスへの標準登録を拒否する
- クライアントへAWS認証情報・IAM権限を渡さない
- 既存の重複ユーザーは自動削除せず、管理者移行とする
- Initial Password Lambdaはログイン済みユーザーのパスワード変更専用とする

## 3. Lambda構成

### 3.1 Guard Lambda

`RAiM_CognitoGuard_Lambda_dev`はPre sign-upを担当する。

- `PreSignUp_ExternalProvider`の許可・拒否を環境変数で切り替える
- `PreSignUp_SignUp`で、同じメールアドレスのGoogle identityが存在する場合に標準登録を拒否する
- その他のイベントはそのまま返す
- `ListUsers`以外の管理APIを呼び出さない

### 3.2 Federation Lambda

`RAiM_CognitoFederation_Lambda_dev`はInbound federationを担当する。

- Googleの`sub`、`email`、`email_verified=true`を検証する
- 検証済みメールに一致する未リンクの標準ユーザーが1件だけの場合にリンクする
- 同じGoogleの`sub`が既にリンク済みなら冪等に終了する
- 複数一致、未検証、競合、AWS APIエラー時は自動リンクしない

### 3.3 Account Link Lambda

`RAiM_CognitoAccountLink_Lambda_dev`はGoogle先行時の公開APIを担当する。

クライアントからUsername、sub、メールアドレスを受け取って対象ユーザーを決定しない。Googleログインで得たアクセストークンから対象ユーザーを特定する。

処理:

1. アクセストークンの署名、発行元、App Client、`token_use`、`sub`、`auth_time`を検証する
2. Google identity、Googleの`email_verified=true`、メールアドレスを確認する
3. 同一メールアドレスの標準ユーザーが複数ないことを確認する
4. 必要なら`AdminCreateUser(MessageAction=SUPPRESS)`で標準ユーザーを作成する
5. `AdminSetUserPassword(Permanent=true)`で標準ユーザーへパスワードを設定する
6. 既存フェデレーションプロフィールを整理する
7. `AdminLinkProviderForUser`でGoogleの`sub`をリンクする
8. 完了後、クライアントへ再ログインを要求する

既にサインインしたフェデレーションプロフィールのリンクでは、AWS公式手順上、既存プロフィールの削除が必要になる場合がある。削除対象はトークンから特定したGoogleプロフィールだけに限定し、任意のUsernameを受け付けない。

### 3.4 Initial Password Lambda

`RAiM_CognitoInitialPassword_Lambda_dev`は、ログイン後の設定メニューからパスワードを変更する専用APIである。Googleユーザーの初回パスワード設定、別ユーザーのパスワード設定、管理者によるパスワード設定には使用しない。

認証済みアクセストークンを使ってCognitoの`ChangePassword`を実行する。`AdminSetUserPassword`は使用しない。

## 4. データとユーザー状態

- アプリデータの正規キーは、リンク後の標準ユーザーのCognito `sub`とする
- Googleのメールアドレスだけをアプリユーザーの識別子にしない
- Googleからの属性マッピングで権限、契約状態、管理者フラグを上書きしない
- 標準ユーザー作成時は歓迎メールを送信しない場合`MessageAction=SUPPRESS`を使用する
- 一時パスワードを指定した`AdminCreateUser`は`FORCE_CHANGE_PASSWORD`になるため、作成後に永続パスワードを設定する

## 5. IAMと信頼境界

Lambdaごとに実行ロールを分離する。

| Lambda | 必要権限 |
|---|---|
| Guard | `cognito-idp:ListUsers` |
| Federation | `cognito-idp:ListUsers`、`cognito-idp:AdminLinkProviderForUser` |
| Account Link | `AdminGetUser`、`ListUsers`、`AdminCreateUser`、`AdminSetUserPassword`、`AdminLinkProviderForUser`、必要な場合のみ`AdminDeleteUser` |
| Initial Password | Cognito管理API権限不要（`ChangePassword`を使用） |

Resourceは対象User Pool ARNに限定する。

```text
arn:aws:cognito-idp:ap-northeast-1:990442281360:userpool/ap-northeast-1_OMFV9fgsG
```

`AdminDeleteUser`はAccount Link Lambdaで必要な対象プロフィール整理に限る。公開APIのリクエストから任意のUsernameを受け取って削除する実装にはしない。既存重複ユーザーの削除・データ移行は、別の管理者専用ロールと処理に分離する。

## 6. Google IdPとCognito設定

- Google IdPを有効化する
- `email`をGoogleの`email`へマッピングする
- `email_verified`をGoogleの`email_verified`へマッピングする
- 必要な場合だけ`name`をマッピングする
- `username -> sub`の手動マッピングは行わない
- メールアドレスをサインイン属性として有効化する
- 対象App Clientで`COGNITO`と`Google`を有効化する
- Pre sign-upにGuardを設定する
- Inbound federationにFederationを設定する

`AdminLinkProviderForUser`のGoogle側は次の値を使用する。

```text
ProviderName             = Google
ProviderAttributeName   = Cognito_Subject
ProviderAttributeValue  = Googleのsub
```

## 7. API境界

Account Link API:

```text
POST /account/link
認可: raim-cognito-authorizer
統合: Lambda proxy
APIキー: 不要
```

Account Link Lambdaの環境変数:

```text
COGNITO_USER_POOL_ID=ap-northeast-1_OMFV9fgsG
COGNITO_APP_CLIENT_ID=<対象App Client ID>
ACCOUNT_LINK_MAX_AUTH_AGE_SECONDS=900
```

Password Change API:

```text
POST /account/password
認可: raim-cognito-authorizer
統合: Lambda proxy
APIキー: 不要
```

パスワード変更APIのリクエストボディは`previousPassword`と`proposedPassword`を受け取る。Account Link APIは`proposedPassword`だけを受け取る。

両方のLambdaでアクセストークンを再検証する。パスワード変更Lambdaは`ChangePassword`だけを使用し、管理者権限で任意ユーザーのパスワードを変更しない。App Clientでは`aws.cognito.signin.user.admin`スコープを許可する。API GatewayのAuthorizerだけを信頼して対象ユーザーを決定しない。パスワード、アクセストークン、Google ID token、AWS認証情報をログに出力しない。

## 8. 失敗・冪等性・同時実行

ユーザー作成、パスワード設定、プロフィール整理、リンクは単一トランザクションではない。

- リクエストIDと対象Cognito `sub`で処理状態を記録する
- 成功済み状態の再実行は再作成せず、状態を確認して成功扱いにする
- 途中失敗時に別ユーザーを追加作成しない
- 作成済み標準ユーザーを無条件に削除しない
- 途中状態を監査ログへ残し、管理者が復旧できるようにする
- `ListUsers`はEventually Consistentのため、ロックを実装しない場合は同時実行で重複しないことを保証しない
- 一意に判定できない場合は自動リンクせず、管理者移行へ回す

## 9. Googleユーザーのみの手動統合

同じメールアドレスのGoogleユーザーだけが存在し、標準ユーザーが存在しない場合は、管理者が次の順で統合する。具体的なコンソール操作とCLIコマンドはAWS側手順書の「既存Googleユーザーのみを手動統合する手順」に従う。

1. GoogleユーザーのUsername、Cognitoの`sub`、`identities.userId`、メールアドレスを記録する
2. アプリデータをバックアップする
3. Cognitoコンソールで同じメールアドレスの標準ユーザーを作成する
4. `email_verified=true`を設定する
5. `AdminSetUserPassword(Permanent=true)`で標準ユーザーへ永続パスワードを設定する
6. 既存Googleプロフィールを`AdminDeleteUser`で削除する
7. Googleの`identities.userId`を`Cognito_Subject`として`AdminLinkProviderForUser`を実行する
8. コンソールでユーザーが1件になり、標準ユーザーの`identities`にGoogleが存在することを確認する
9. Google・パスワードログインとアプリデータを確認する

この処理は破壊的な削除を含むため、Account Link Lambdaまたは通常のログイン処理から自動実行しない。リンク前に、削除対象がGoogleプロフィールであることを再確認する。

## 10. 既存重複ユーザーの移行

標準ユーザーとGoogleユーザーが既に別々に存在する場合、公開APIから自動統合・自動削除しない。

1. 本人確認
2. Username、Cognitoの`sub`、Googleの`sub`の記録
3. アプリデータと属性のバックアップ
4. 正規ユーザーの決定
5. アプリデータの移行
6. AWS公式手順に従った不要プロフィールの整理
7. `AdminLinkProviderForUser`
8. Google・パスワードログインの確認
9. 移行記録の保存

## 11. テスト

- Guardの外部IdP登録On/Off
- Googleユーザーなしの標準登録許可
- Googleユーザーと同じメールの標準登録拒否
- 標準先行でGoogle identityが標準ユーザーへリンクされる
- Google先行で標準ユーザー作成、パスワード設定、リンクが完了する
- 同じリクエストを再実行してもユーザーが増えない
- Username、sub、メールアドレスの差し替えを拒否する
- `email_verified=false`、複数一致、別Google`sub`を拒否する
- 途中失敗後に管理者が復旧できる
- ログイン済みユーザーが設定メニューからパスワードを変更できる
- パスワード変更でUsernameやsubの差し替えを拒否する
- 未認証、期限切れ、別App Clientのトークンを拒否する
- パスワード・トークン・AWS認証情報がログに出ない
- API Gatewayの認可、HTTPS、ステージデプロイ、レート制限を確認する

## 12. 参考

- [Cognitoユーザーの統合](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-identity-federation-consolidate-users.html)
- [AdminLinkProviderForUser](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminLinkProviderForUser.html)
- [AdminCreateUser](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminCreateUser.html)
- [AdminSetUserPassword](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminSetUserPassword.html)
- [ChangePassword](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_ChangePassword.html)
- [ListUsers](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_ListUsers.html)
