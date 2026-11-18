# RAiM Cognito initial password Lambda

## 位置づけ

このLambdaは、ログイン後の設定メニューから、認証済みユーザー自身がパスワードを変更するためのAPIである。

Google先行時の初回パスワード設定はAccount Link Lambdaが担当する。このLambdaではGoogleプロフィールへの初回パスワード設定、別ユーザーのパスワード設定、管理者によるパスワード設定を行わない。

## Runtime configuration

```text
COGNITO_USER_POOL_ID=ap-northeast-1_OMFV9fgsG
COGNITO_APP_CLIENT_ID=<Cognito app client ID>
```

## API

```http
POST /account/password
Authorization: Bearer <Cognito access token>
Content-Type: application/json

{"previousPassword":"<current password>","proposedPassword":"<new password>"}
```

APIはアクセストークン、現在のパスワード、新しいパスワードを使ってCognitoの`ChangePassword`を実行する。クライアントからUsername、sub、メールアドレス、AWS認証情報を受け取らない。管理者APIの`AdminSetUserPassword`は使用しない。

## 新規フローとの関係

- Google先行の新規統合は`POST /account/link`を使用する
- パスワード変更はログイン済みユーザー自身の操作だけを許可する
- 重複ユーザーの削除・データ移行は本Lambdaや公開APIへ追加しない

## セキュリティ

- パスワードをログ出力・保存しない
- HTTPSでのみ受け付ける
- アクセストークンの署名、発行者、App Client、`token_use`、`sub`を検証する
- `aws.cognito.signin.user.admin`スコープを要求する
- IAMのCognito管理API権限を付与しない
- User Pool ARNに権限を限定する
- レート制限と監査ログを設定する
- `AdminDeleteUser`を付与しない

## Handler

```text
index.handler
```
