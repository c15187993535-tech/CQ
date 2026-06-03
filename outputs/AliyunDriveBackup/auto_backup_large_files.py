#!/usr/bin/env python3
import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path(os.environ.get("CODEX_REPO_ROOT", Path(__file__).resolve().parents[2])).resolve()
BACKUP_ROOT = Path(os.environ.get("CODEX_BACKUP_ROOT", Path(__file__).resolve().parent)).resolve()
DEFAULT_MIN_SIZE_MB = 50

ARCHIVE_EXTS = {".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".dmg", ".pkg"}
MEDIA_EXTS = {
    ".mp4",
    ".mov",
    ".m4v",
    ".avi",
    ".mkv",
    ".mp3",
    ".wav",
    ".m4a",
    ".aac",
    ".flac",
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".heic",
}
DOCUMENT_EXTS = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".key", ".pages", ".numbers"}


def log(message):
    print(message, flush=True)


def category_for(path):
    suffix = path.suffix.lower()
    if suffix in ARCHIVE_EXTS:
        return "archives"
    if suffix in MEDIA_EXTS:
        return "media"
    if suffix in DOCUMENT_EXTS:
        return "documents"
    return "large-files"


def unique_destination(destination):
    if not destination.exists():
        return destination

    stem = destination.stem
    suffix = destination.suffix
    parent = destination.parent
    counter = 2
    while True:
        candidate = parent / f"{stem}-{counter}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def should_scan(path):
    if not path.is_file():
        return False
    if BACKUP_ROOT in path.resolve().parents:
        return False
    if ".git" in path.parts:
        return False
    if path.name in {".DS_Store", ".gitkeep"}:
        return False
    return True


def collect_large_files(min_size_bytes, dry_run=False):
    moved = []
    scan_roots = [REPO_ROOT / "work", REPO_ROOT / "outputs"]

    for root in scan_roots:
        if not root.exists():
            continue
        for current_root, _, files in os.walk(root):
            for filename in files:
                source = Path(current_root) / filename
                if not should_scan(source):
                    continue
                if source.stat().st_size < min_size_bytes:
                    continue

                category = category_for(source)
                destination_dir = BACKUP_ROOT / category
                destination_dir.mkdir(parents=True, exist_ok=True)
                destination = unique_destination(destination_dir / source.name)

                if dry_run:
                    log(f"将移动: {source} -> {destination}")
                else:
                    shutil.move(str(source), str(destination))
                    log(f"已移动: {source} -> {destination}")
                moved.append((source, destination))

    return moved


def run_sync(dry_run=False):
    sync_script = Path(__file__).resolve().parent / "sync_to_aliyun.py"
    command = [sys.executable, str(sync_script)]
    if dry_run:
        command.append("--dry-run")
    subprocess.check_call(command)


def main():
    parser = argparse.ArgumentParser(description="Move generated large files into AliyunDriveBackup, then sync.")
    parser.add_argument("--min-size-mb", type=int, default=DEFAULT_MIN_SIZE_MB)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-sync", action="store_true")
    args = parser.parse_args()

    min_size_bytes = args.min_size_mb * 1024 * 1024
    moved = collect_large_files(min_size_bytes, dry_run=args.dry_run)
    log(f"大文件整理完成: moved={len(moved)}, threshold={args.min_size_mb}MB")

    if not args.no_sync:
        run_sync(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
