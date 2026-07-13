#!/usr/bin/env python3
"""既存問題JSONを全走査し、出典-分野プレフィクスごとの「次に使う連番ID」を表示する。

ingest時のID採番はこの出力に従う（手で数えない・推測しない）。

使い方:
  python3 scripts/next_ids.py               # 全プレフィクスの次ID一覧
  python3 scripts/next_ids.py mondai26-env  # 特定プレフィクスの次IDのみ

出力例:
  mondai26-env: 次は mondai26-env-013（既存 12 問）
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ID_RE = re.compile(r"^(.+)-(\d{3})$")


def main(argv):
    filter_prefix = argv[0] if argv else None
    counts = {}  # prefix -> max seq
    for path in sorted(glob.glob(os.path.join(ROOT, "data", "questions", "*.json"))):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            print(f"[警告] {path}: 読込失敗 {e}", file=sys.stderr)
            continue
        questions = data.get("questions", data) if isinstance(data, dict) else data
        if not isinstance(questions, list):
            continue
        for q in questions:
            qid = q.get("id") if isinstance(q, dict) else None
            m = ID_RE.match(qid) if isinstance(qid, str) else None
            if m:
                prefix, seq = m.group(1), int(m.group(2))
                counts[prefix] = max(counts.get(prefix, 0), seq)
    if not counts:
        print("既存問題なし。連番は 001 から開始")
        return 0
    for prefix in sorted(counts):
        if filter_prefix and prefix != filter_prefix:
            continue
        n = counts[prefix]
        print(f"{prefix}: 次は {prefix}-{n + 1:03d}（既存最大 {n:03d}）")
    if filter_prefix and filter_prefix not in counts:
        print(f"{filter_prefix}: 既存なし。次は {filter_prefix}-001")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
