#!/usr/bin/env python3
"""問題JSONの paper_results（紙で解いた際の手書き ○×。古い周→新しい周の順）を、
アプリの「バックアップ復元」で取り込める attempts 形式に変換する。

使い方:
  python3 scripts/paper_results_to_attempts.py <問題JSON...> --dates 2026-09-15 2026-10-01 > out.json
  各周回の名目日付（古い順）。マークが日付数より多い問題は最後のN個（直近の周）を採用する。
出力: {"questions": [], "attempts": [...]}（復元はこの形式を要求。questions は空＝問題は更新しない）
      attempts: {question_id, timestamp, correct, time_sec: null, confidence: null, mode: "paper", round}
"?"（判読不能）は含めない。
"""
import json, sys
from datetime import datetime, timezone, timedelta

def main(argv):
    if "--dates" not in argv:
        print(__doc__); return 1
    i = argv.index("--dates"); paths, dates = argv[:i], argv[i+1:]
    jst = timezone(timedelta(hours=9))
    stamps = [int(datetime.strptime(d, "%Y-%m-%d").replace(hour=12, tzinfo=jst).timestamp() * 1000) for d in dates]
    attempts, skipped = [], 0
    for path in paths:
        data = json.load(open(path, encoding="utf-8"))
        for q in (data["questions"] if isinstance(data, dict) else data):
            marks = [m for m in (q.get("paper_results") or []) if m in ("○", "×")]
            skipped += len([m for m in (q.get("paper_results") or []) if m not in ("○", "×")])
            marks = marks[-len(stamps):]  # 直近N周
            offset = len(stamps) - len(marks)
            for j, mark in enumerate(marks):
                attempts.append({"question_id": q["id"], "timestamp": stamps[offset + j] + len(attempts),
                                 "correct": mark == "○", "time_sec": None, "confidence": None, "mode": "paper", "round": offset + j + 1})
    json.dump({"questions": [], "attempts": attempts}, sys.stdout, ensure_ascii=False, indent=1)
    print(f"\n# attempts {len(attempts)} 件 / 判読不能スキップ {skipped} 件", file=sys.stderr)
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
