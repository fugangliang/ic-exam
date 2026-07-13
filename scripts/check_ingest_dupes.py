#!/usr/bin/env python3
"""取込画像の重複チェック（ingestパイプライン用）。

内容ハッシュ(SHA-256)で照合するため、ファイル名が変わった再送でも検出できる。
台帳: processed/.ingest_manifest.json（{"<sha256>": {"file": 名前, "date": 登録日}}）

使い方:
  python3 scripts/check_ingest_dupes.py --check IC_scan/*      # 取込前: 新規/重複を判定
  python3 scripts/check_ingest_dupes.py --register inbox/*     # 取込後: 台帳へ登録
  python3 scripts/check_ingest_dupes.py --rebuild              # processed/ から台帳を再構築

注意: 取込確定画像は削除する運用（2026-07-13〜）のため、--rebuild は processed/ に
実在するファイル分しか復元できない＝削除済み画像のハッシュが台帳から消える。
台帳が破損した場合以外は使わないこと。

終了コード: --check は重複が1件でもあれば 2（新規のみなら 0）。他は 0=OK / 1=エラー
"""
import hashlib
import json
import os
import sys
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST = os.path.join(ROOT, "processed", ".ingest_manifest.json")
EXTS = {".jpg", ".jpeg", ".png", ".heic", ".pdf"}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_manifest():
    if not os.path.exists(MANIFEST):
        return {}
    with open(MANIFEST, encoding="utf-8") as f:
        return json.load(f)


def save_manifest(m):
    os.makedirs(os.path.dirname(MANIFEST), exist_ok=True)
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=1)


def target_files(paths):
    return [p for p in paths
            if os.path.isfile(p) and os.path.splitext(p)[1].lower() in EXTS]


def cmd_check(paths):
    manifest = load_manifest()
    files = target_files(paths)
    if not files:
        print("対象ファイルなし")
        return 0
    new, dup = [], []
    seen_now = {}  # 同一バッチ内の重複も検出
    for p in files:
        h = sha256(p)
        if h in manifest:
            dup.append((p, manifest[h]["file"], manifest[h]["date"]))
        elif h in seen_now:
            dup.append((p, seen_now[h] + "（同バッチ内）", "今回"))
        else:
            new.append(p)
            seen_now[h] = os.path.basename(p)
    for p in new:
        print(f"[NEW] {p}")
    for p, orig, d in dup:
        print(f"[DUP] {p} == {orig}（登録日: {d}）→ 取込対象外")
    print(f"---\n新規 {len(new)} / 重複 {len(dup)}")
    return 2 if dup else 0


def cmd_register(paths):
    manifest = load_manifest()
    files = target_files(paths)
    added = 0
    for p in files:
        h = sha256(p)
        if h not in manifest:
            manifest[h] = {"file": os.path.basename(p), "date": date.today().isoformat()}
            added += 1
    save_manifest(manifest)
    print(f"登録 {added} 件（台帳合計 {len(manifest)} 件）")
    return 0


def cmd_rebuild():
    processed = os.path.join(ROOT, "processed")
    files = target_files(
        [os.path.join(processed, f) for f in os.listdir(processed)]
    ) if os.path.isdir(processed) else []
    manifest = {}
    for p in files:
        manifest[sha256(p)] = {"file": os.path.basename(p), "date": date.today().isoformat()}
    save_manifest(manifest)
    print(f"再構築 {len(manifest)} 件")
    return 0


def main(argv):
    if not argv:
        print(__doc__)
        return 1
    cmd, paths = argv[0], argv[1:]
    if cmd == "--check":
        return cmd_check(paths)
    if cmd == "--register":
        return cmd_register(paths)
    if cmd == "--rebuild":
        return cmd_rebuild()
    print(f"不明なコマンド: {cmd}\n{__doc__}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
