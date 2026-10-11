#!/usr/bin/env python3
"""問題JSON全部＋解答履歴ファイル（data/attempts/*.json）を1つに統合し、アプリの
「バックアップ復元」で1回で取り込める統合ファイルを作る（①問題をアプリに統合反映）。

使い方:
  python3 scripts/build_bundle.py            # data/bundle/ic-exam_bundle_YYYYMMDD.json を生成
出力形式: {"questions":[...全問...], "attempts":[...]}  attempts は data/attempts/ 配下の各ファイルの attempts を連結。
注意: 復元は attempts を「追加」するため、同じ統合ファイルを2回復元すると履歴が重複する。
      問題だけを更新したいときは questions のみのファイルを ⚙ import で読み込むこと。
"""
import glob, json, os, sys
from datetime import date
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def load(p):
    d = json.load(open(p, encoding="utf-8"))
    return d if isinstance(d, dict) else {"questions": d}

qs, seen = [], set()
for p in sorted(glob.glob(os.path.join(ROOT, "data", "questions", "*.json"))):
    for q in load(p)["questions"]:
        if q["id"] in seen: print(f"[警告] id重複 {q['id']} @ {p}", file=sys.stderr); continue
        seen.add(q["id"]); qs.append(q)
att = []
for p in sorted(glob.glob(os.path.join(ROOT, "data", "attempts", "*.json"))):
    if "bundle" in p: continue
    att += load(p).get("attempts", [])
out = os.path.join(ROOT, "data", "bundle", f"ic-exam_bundle_{date.today().strftime('%Y%m%d')}.json")
os.makedirs(os.path.dirname(out), exist_ok=True)
json.dump({"exported_at": date.today().isoformat(), "note": "統合ファイル。アプリ⚙→バックアップ復元で読み込む（attemptsは追加されるため1回だけ）",
           "questions": qs, "attempts": att}, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{out}: 問題 {len(qs)} / 履歴 {len(att)}")
