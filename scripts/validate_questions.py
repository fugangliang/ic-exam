#!/usr/bin/env python3
"""問題JSONのスキーマ検証・ID重複・問題文重複チェック（ingestパイプライン用）。

使い方:
  python3 scripts/validate_questions.py data/questions/*.json
  python3 scripts/validate_questions.py <ファイル...>

app/logic.js の validateQuestion と同一基準。全ファイル横断で以下も検出する:
- ID重複
- 問題文の実質重複（空白・改行を除去して正規化したbodyが一致 → 同一問題の二重取込）
終了コード: 0=OK / 1=エラーあり
"""
import json
import re
import sys

REQUIRED_STR = ["id", "category", "body"]


def normalize_body(q):
    """問題文＋選択肢から空白類を除去した重複判定キーを作る。"""
    body = q.get("body", "") if isinstance(q, dict) else ""
    choices = q.get("choices", []) if isinstance(q, dict) else []
    text = body + "|" + "|".join(c for c in choices if isinstance(c, str))
    return re.sub(r"\s+", "", text)


def validate_question(q):
    errs = []
    if not isinstance(q, dict):
        return ["not an object"]
    for f in REQUIRED_STR:
        if not isinstance(q.get(f), str) or not q[f].strip():
            errs.append(f"{f} が空")
    choices = q.get("choices")
    if not isinstance(choices, list) or len(choices) < 2:
        errs.append("choices が2件未満")
    elif any(not isinstance(c, str) or not c.strip() for c in choices):
        errs.append("choices に空要素")
    ans = q.get("answer")
    if not isinstance(ans, int) or isinstance(ans, bool) or ans < 0 or (
        isinstance(choices, list) and ans >= len(choices)
    ):
        errs.append("answer が choices の範囲外")
    if not isinstance(q.get("explanation"), str):
        errs.append("explanation がない")
    return errs


def load_questions(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("questions"), list):
        return data["questions"]
    raise ValueError("形式不正: 配列または {questions:[...]} が必要")


def main(paths):
    if not paths:
        print(__doc__)
        return 1
    seen = {}  # id -> path
    seen_body = {}  # normalized body -> (id, path)
    total, errors = 0, 0
    for path in paths:
        try:
            questions = load_questions(path)
        except (json.JSONDecodeError, ValueError, OSError) as e:
            print(f"[NG] {path}: {e}")
            errors += 1
            continue
        for i, q in enumerate(questions):
            total += 1
            qid = q.get("id", "?") if isinstance(q, dict) else "?"
            errs = validate_question(q)
            if isinstance(qid, str) and qid in seen:
                errs.append(f"ID重複（既出: {seen[qid]}）")
            elif isinstance(qid, str):
                seen[qid] = path
            key = normalize_body(q)
            if key.strip("|"):
                if key in seen_body:
                    dup_id, dup_path = seen_body[key]
                    errs.append(f"問題文重複（既出: id={dup_id} @ {dup_path}）")
                else:
                    seen_body[key] = (qid, path)
            if errs:
                errors += 1
                print(f"[NG] {path} #{i} id={qid}: {'; '.join(errs)}")
    print(f"---\n検証 {total} 問 / エラー {errors} 件")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
