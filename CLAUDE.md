# CLAUDE.md — IC試験対策アプリ

インテリアコーディネーター一次試験（2026年度・第44回、CBT）対策の本人専用PWA。
要件の正本: `docs/IC試験対策アプリ_要件定義書_v0.3.md`（必ず参照してから作業する）。

## 最重要ルール

- **問題データ（`data/`, `inbox/`, `processed/`）は絶対にgit管理・push しない**（.gitignore済み）。
  市販問題集由来のデータであり私的使用限定。GitHub Pagesはprivateリポジトリでも公開URLになるため、
  デプロイするのはアプリ本体（`app/`）のみ。問題データはアプリのimport機能（F5）で端末に直接投入する。
- 問題データの取り込み・生成では**推測補完禁止**。読み取り不能・根拠不明は必ず人間レビューに回す。
- スケジュール優先度: アプリは手段。「今日から演習を回せる」状態の維持がUI品質より常に優先。

## 構成

```
app/        PWA本体（vanilla JS・ビルド工程なし。index.html/app.js/logic.js/db.js/sw.js）
data/questions/  分野別問題JSON（git対象外）
IC_scan/    スキャン画像の着地先（RFがAirDrop受信後ここに置く・git対象外）
inbox/      未処理の撮影画像（git対象外）
processed/  取込台帳 .ingest_manifest.json＋[要確認]画像のみ（取込確定画像は削除・git対象外）
scripts/    検証・テスト
docs/       要件定義書
```

## 開発ルール

- ビルド工程なし。`logic.js` は純粋関数のみ（DOM/DB非依存、nodeでテスト可能）。
- 変更時は必ず実行: `node scripts/test_logic.js` と `node --check app/*.js`
- 問題JSONを追加したら: `python3 scripts/validate_questions.py data/questions/*.json`
- `app/` 内のファイル構成を変えたら `sw.js` の SHELL リストと VERSION を更新する。
- 動作確認: `python3 -m http.server 8000 -d app` → http://localhost:8000/
- デプロイ: `scripts/deploy.sh`（テスト→main push→app/ を gh-pages に subtree split して push）。
  公開URL: https://fugangliang.github.io/ic-exam/ （publicリポジトリのため docs/ もgit対象外。配信されるのは app/ のみ）

## データ運用フロー（日次: 撮る→取り込む→解く）

1. iPhoneの書類スキャンで問題＋解説ページを撮影 → **AirDropでMacへ転送し `IC_scan/` に置く**
   （確定: iCloud Drive は使わない。RF決定 2026-07-13）
2. Claude Codeで `/ingest` 実行（画像収集→重複除外→JSON化→検証→台帳登録→画像削除まで一括）。
   重複は二重で防ぐ: 画像は内容ハッシュ台帳（`check_ingest_dupes.py`）、問題は
   `validate_questions.py` のID重複＋問題文重複チェック。
   取込確定した画像は削除する（ディスク節約。台帳にハッシュが残るので再送重複は検出可能）。
   `[要確認]` 問題を含む画像のみ人間レビュー解消まで `processed/` に残す
3. 生成JSONをiPhoneにAirDrop → アプリ⚙「問題データimport」で取り込み
4. **画像・問題JSONはGitHubにアップロードしない**（アプリ本体の更新時のみ `scripts/deploy.sh`）

## 問題JSONスキーマ

```json
{
  "id": "2022-kankyo-001",
  "category": "環境・設備",
  "subcategory": "換気",
  "source": "2022年度 or オリジナル",
  "body": "問題文",
  "choices": ["肢1", "肢2", "肢3", "肢4"],
  "answer": 1,
  "explanation": "正答理由＋各誤答肢がなぜ誤りか",
  "has_figure": false,
  "figure_ref": null,
  "difficulty": 2
}
```
answer は0始まりのindex。import形式は配列 or `{questions:[...]}`。

## フェーズ（要件定義書 §7）

- P1（7/7〜7/14）: 出題モード1,2＋解答履歴＋自信度＋静的解説＋JSON import → **実装済み**
- 7/15〜7/31: 機能追加凍結（バグ修正のみ）。データ制作優先
- P2（8/1〜8/15）: ダッシュボード・弱点集中・SRS・図版
- P3（8/16〜9/15）: 模試モード優先
- 9/16以降: 完全凍結
