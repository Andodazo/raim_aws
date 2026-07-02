import base64
import hashlib
import os
import secrets
import string
import urllib.parse
import webbrowser
import requests


COGNITO_DOMAIN = "https://ap-northeast-1omfv9fgsg.auth.ap-northeast-1.amazoncognito.com"
APP_CLIENT_ID = "3s1n1qe8vlsihh2j2dlcs4ecf5"
CALLBACK_URL = "http://localhost:3000/callback"


def generate_code_verifier(length=64):
    chars = string.ascii_letters + string.digits + "-._~"
    return "".join(secrets.choice(chars) for _ in range(length))


def generate_code_challenge(code_verifier):
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def main():
    code_verifier = generate_code_verifier()
    code_challenge = generate_code_challenge(code_verifier)

    params = {
        "client_id": APP_CLIENT_ID,
        "response_type": "code",
        "scope": "email openid phone",
        "redirect_uri": CALLBACK_URL,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }

    auth_url = f"{COGNITO_DOMAIN}/login?{urllib.parse.urlencode(params)}"

    print("=== Open this URL ===")
    print(auth_url)
    print()
    print("code_verifier:")
    print(code_verifier)
    print()

    webbrowser.open(auth_url)

    redirected_url = input("ログイン後に表示されたURLを貼って: ").strip()

    parsed = urllib.parse.urlparse(redirected_url)
    query = urllib.parse.parse_qs(parsed.query)
    code = query.get("code", [None])[0]

    if not code:
        print("code が見つからなかった。URLを確認して。")
        return

    token_url = f"{COGNITO_DOMAIN}/oauth2/token"

    data = {
        "grant_type": "authorization_code",
        "client_id": APP_CLIENT_ID,
        "code": code,
        "redirect_uri": CALLBACK_URL,
        "code_verifier": code_verifier,
    }

    response = requests.post(
        token_url,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data=data,
    )

    print()
    print("=== Token endpoint response ===")
    print("status:", response.status_code)
    print(response.text)


if __name__ == "__main__":
    main()