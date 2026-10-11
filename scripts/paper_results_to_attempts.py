#!/usr/bin/env python3
"""問題JSONの paper_results（紙で解いた際の手書き ○×。1周目→2周目の順）を、
アプリの「バックアップ復元」で取り込める attempts 形式に変換する。

使い方:
  python3 scripts/paper_results_to_attempts.py data/questions/itto_261011.json 2026-09-20 2026-10-05 > out.json
    第2引数以降 = 各周回の解答日（周回数ぶん。日付は 12:00 JST とする）

出力: {"questions": [...元の問題...], "attempts": [...]}  ※ restore はこの形式を要求するため問題も同梱する。
      attempts: {question_id, timestamp, correct, time_sec: 0, confidence: null, mode: "paper", round: n}
"?" のマークは解答不明として attempts に含めない（推測補完禁止）。
"""
import json, sys
from datetime import datetime, timezone, timedelta

def main(argv):
    if len(argv) < 2:
        print(__doc__); return 1
    path, dates = argv[0], argv[1:]
    data = json.load(open(path, encoding="utf-8"))
    qs = data["questions"] if isinstance(data, dict) else data
    jst = timezone(timedelta(hours=9))
    stamps = [int(datetime.strptime(d, "%Y-%m-%d").replace(hour=12, tzinfo=jst).timestamp() * 1000) for d in dates]
    attempts, skipped = [], 0
    for q in qs:
        for i, mark in enumerate(q.get("paper_results") or []):
            if i >= len(stamps):
                skipped += 1; continue
            if mark not in ("○", "×"):
                skipped += 1; continue
            attempts.append({"question_id": q["id"], "timestamp": stamps[i] + len(attempts),
                             "correct": mark == "○", "time_sec": 0, "confidence": None, "mode": "paper", "round": i + 1})
    json.dump({"questions": qs, "attempts": attempts}, sys.stdout, ensure_ascii=False, indent=1)
    print(f"\n# attempts {len(attempts)} 件 / スキップ {skipped} 件（日付不足・判読不能）", file=sys.stderr)
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
