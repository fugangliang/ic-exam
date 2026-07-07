# IC試験対策アプリ

インテリアコーディネーター一次試験（CBT）対策の本人専用PWA。要件は `docs/` の要件定義書を参照。

## 使い方（ローカル起動）

```
python3 -m http.server 8000 -d app
```

→ http://localhost:8000/ を開く。スマホで使う場合はGitHub Pagesにデプロイ後、
Safariで開いて「ホーム画面に追加」。

## 問題データの投入

問題データはリポジトリに含めない（`.gitignore`）。アプリの ⚙ データ管理画面から
問題JSONをimportする。スキーマは `CLAUDE.md` を参照。
検証: `python3 scripts/validate_questions.py <file.json>`

## テスト

```
node scripts/test_logic.js
```
