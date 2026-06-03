#!/usr/bin/env python3
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path


HOME = Path.home()
ADRIVE_STORAGE = HOME / "Library/Application Support/aDrive/Partitions/adrive/Local Storage/leveldb"
API_BASE = "https://api.aliyundrive.com"
AUTH_BASE = "https://auth.aliyundrive.com"
CHUNK_SIZE = 10 * 1024 * 1024


def log(message):
    print(f"[{dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def http_json(url, token=None, data=None, method="POST"):
    body = json.dumps(data or {}).encode("utf-8")
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code} {url}: {raw}") from exc


def http_put(upload_url, chunk):
    req = urllib.request.Request(upload_url, data=chunk, method="PUT")
    with urllib.request.urlopen(req, timeout=300) as resp:
        resp.read()


def extract_json_objects(text):
    decoder = json.JSONDecoder()
    pos = 0
    while True:
        start = text.find("{", pos)
        if start == -1:
            return
        try:
            obj, end = decoder.raw_decode(text[start:])
            yield obj
            pos = start + end
        except json.JSONDecodeError:
            pos = start + 1


def read_login_state():
    if not ADRIVE_STORAGE.exists():
        raise RuntimeError(f"阿里云盘登录数据目录不存在: {ADRIVE_STORAGE}")

    candidates = []
    for file_path in ADRIVE_STORAGE.iterdir():
        if file_path.suffix not in {".ldb", ".log"}:
            continue
        try:
            raw = subprocess.check_output(["strings", str(file_path)], text=True, errors="ignore")
        except subprocess.CalledProcessError:
            continue
        for line in raw.splitlines():
            if '"access_token"' not in line or '"refresh_token"' not in line:
                continue
            for obj in extract_json_objects(line):
                if obj.get("access_token") and obj.get("default_drive_id"):
                    candidates.append(obj)

    if not candidates:
        raise RuntimeError("没有找到阿里云盘登录态。请打开阿里云盘客户端并确认已登录。")

    candidates.sort(key=lambda item: item.get("expire_time", ""))
    state = candidates[-1]
    return refresh_login_state(state)


def refresh_login_state(state):
    expire_raw = state.get("expire_time")
    if expire_raw:
        try:
            expire_at = dt.datetime.fromisoformat(expire_raw.replace("Z", "+00:00"))
            if expire_at > dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=10):
                return state
        except ValueError:
            pass

    refresh_token = state.get("refresh_token")
    if not refresh_token:
        return state

    refreshed = http_json(
        f"{AUTH_BASE}/v2/account/token",
        data={"grant_type": "refresh_token", "refresh_token": refresh_token},
    )
    if refreshed.get("access_token"):
        state.update(refreshed)
    return state


def list_children(token, drive_id, parent_file_id):
    items = []
    marker = None
    while True:
        payload = {
            "drive_id": drive_id,
            "parent_file_id": parent_file_id,
            "limit": 100,
            "all": False,
            "fields": "*",
            "order_by": "name",
            "order_direction": "ASC",
        }
        if marker:
            payload["marker"] = marker
        data = http_json(f"{API_BASE}/adrive/v3/file/list", token=token, data=payload)
        items.extend(data.get("items", []))
        marker = data.get("next_marker")
        if not marker:
            break
    return items


def find_child(token, drive_id, parent_file_id, name, file_type=None):
    for item in list_children(token, drive_id, parent_file_id):
        if item.get("name") == name and (file_type is None or item.get("type") == file_type):
            return item
    return None


def ensure_folder(token, drive_id, parent_file_id, name):
    existing = find_child(token, drive_id, parent_file_id, name, "folder")
    if existing:
        return existing["file_id"]
    created = http_json(
        f"{API_BASE}/adrive/v2/file/createWithFolders",
        token=token,
        data={
            "drive_id": drive_id,
            "parent_file_id": parent_file_id,
            "name": name,
            "type": "folder",
            "check_name_mode": "refuse",
        },
    )
    return created["file_id"]


def part_info_list(size):
    count = max(1, (size + CHUNK_SIZE - 1) // CHUNK_SIZE)
    return [{"part_number": number} for number in range(1, count + 1)]


def sha1_file(path):
    digest = hashlib.sha1()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest().upper()


def upload_file(token, drive_id, parent_file_id, path, dry_run=False):
    size = path.stat().st_size
    existing = find_child(token, drive_id, parent_file_id, path.name, "file")
    if existing and existing.get("size") == size:
        log(f"跳过已存在: {path}")
        return "skipped"

    if dry_run:
        log(f"将上传: {path}")
        return "dry-run"

    content_hash = sha1_file(path)
    created = http_json(
        f"{API_BASE}/adrive/v2/file/createWithFolders",
        token=token,
        data={
            "drive_id": drive_id,
            "parent_file_id": parent_file_id,
            "name": path.name,
            "type": "file",
            "check_name_mode": "auto_rename",
            "size": size,
            "content_hash": content_hash,
            "content_hash_name": "sha1",
            "part_info_list": part_info_list(size),
        },
    )

    file_id = created.get("file_id")
    upload_id = created.get("upload_id")
    parts = created.get("part_info_list") or []

    if not upload_id and created.get("rapid_upload"):
        log(f"秒传成功: {path}")
        return "uploaded"

    if not file_id or not upload_id or not parts:
        raise RuntimeError(f"创建上传任务失败: {path} -> {created}")

    with path.open("rb") as handle:
        for part in parts:
            upload_url = part["upload_url"]
            chunk = handle.read(CHUNK_SIZE)
            http_put(upload_url, chunk)

    http_json(
        f"{API_BASE}/v2/file/complete",
        token=token,
        data={"drive_id": drive_id, "file_id": file_id, "upload_id": upload_id},
    )
    log(f"上传完成: {path}")
    return "uploaded"


def should_skip(path):
    return path.name in {".gitkeep", ".DS_Store"} or path.name.endswith(".log")


def sync(local_root, dry_run=False):
    state = read_login_state()
    token = state["access_token"]
    drive_id = str(state["default_drive_id"])

    codex_id = ensure_folder(token, drive_id, "root", "Codex")
    remote_root_id = ensure_folder(token, drive_id, codex_id, "AliyunDriveBackup")

    folder_cache = {local_root.resolve(): remote_root_id}
    uploaded = skipped = 0

    for current_root, dirs, files in os.walk(local_root):
        current_path = Path(current_root)
        remote_parent = folder_cache[current_path.resolve()]

        for dirname in sorted(dirs):
            local_dir = current_path / dirname
            remote_id = ensure_folder(token, drive_id, remote_parent, dirname)
            folder_cache[local_dir.resolve()] = remote_id

        for filename in sorted(files):
            local_file = current_path / filename
            if should_skip(local_file) or local_file.name == Path(__file__).name:
                continue
            result = upload_file(token, drive_id, remote_parent, local_file, dry_run=dry_run)
            if result == "skipped":
                skipped += 1
            else:
                uploaded += 1

    log(f"同步结束: uploaded={uploaded}, skipped={skipped}, local={local_root}")


def main():
    parser = argparse.ArgumentParser(description="Sync AliyunDriveBackup files to Aliyun Drive/Codex.")
    parser.add_argument(
        "--local-root",
        default=os.environ.get("CODEX_BACKUP_ROOT", str(Path(__file__).resolve().parent)),
        help="Local AliyunDriveBackup folder.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Only print what would be uploaded.")
    args = parser.parse_args()

    local_root = Path(args.local_root).expanduser().resolve()
    if not local_root.exists():
        raise SystemExit(f"本地备份目录不存在: {local_root}")
    sync(local_root, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
