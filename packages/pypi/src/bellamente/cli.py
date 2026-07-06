from __future__ import annotations

import hashlib
import os
import platform
import stat
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

from . import __version__

REPO = "The-Little-AI-Company/bellamente"
BASE_URL = os.environ.get("BELLA_DOWNLOAD_BASE", f"https://github.com/{REPO}/releases/download/v{__version__}")


def platform_asset(system: str = sys.platform, machine: str | None = None) -> str:
    machine = (machine or platform.machine()).lower()
    if system.startswith("win") and machine in {"amd64", "x86_64"}:
        return "bella-windows-x64.exe"
    if system.startswith("linux") and machine in {"amd64", "x86_64"}:
        return "bella-linux-x64"
    raise RuntimeError(f"Bellamente currently publishes binaries for Windows x64 and Linux x64 only; detected {system}/{machine}.")


def cache_root() -> Path:
    override = os.environ.get("BELLA_BIN_CACHE")
    if override:
        return Path(override)
    if sys.platform.startswith("win") and os.environ.get("LOCALAPPDATA"):
        return Path(os.environ["LOCALAPPDATA"]) / "Bellamente" / "Launcher"
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "bellamente" / "launcher"


def fetch_bytes(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=300) as res:
        return res.read()


def parse_checksums(text: str) -> dict[str, str]:
    checksums: dict[str, str] = {}
    for line in text.splitlines():
        parts = line.strip().split()
        if len(parts) >= 2 and len(parts[0]) == 64:
            checksums[parts[-1].lstrip("*")] = parts[0].lower()
    return checksums


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read_cached_sha(path: Path) -> str:
    try:
        text = path.with_name(f"{path.name}.sha256").read_text(encoding="utf-8").strip().lower()
    except OSError:
        return ""
    return text if len(text) == 64 and all(c in "0123456789abcdef" for c in text) else ""


def write_cached_sha(path: Path, expected: str) -> None:
    path.with_name(f"{path.name}.sha256").write_text(f"{expected}\n", encoding="utf-8")


def download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=dest.name, suffix=".tmp", dir=dest.parent)
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        tmp.write_bytes(fetch_bytes(url))
        if not sys.platform.startswith("win"):
            tmp.chmod(tmp.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        tmp.replace(dest)
    finally:
        if tmp.exists():
            tmp.unlink()


def ensure_binary() -> Path:
    asset = platform_asset()
    dest = cache_root() / __version__ / asset
    cached = read_cached_sha(dest)
    if cached and dest.exists() and sha256(dest) == cached:
        return dest
    checksums = parse_checksums(fetch_bytes(f"{BASE_URL}/SHA256SUMS.txt").decode("utf-8"))
    expected = checksums.get(asset)
    if not expected:
        raise RuntimeError(f"SHA256SUMS.txt did not contain {asset}")
    if not dest.exists() or sha256(dest) != expected:
        download(f"{BASE_URL}/{asset}", dest)
    if sha256(dest) != expected:
        raise RuntimeError(f"checksum mismatch for {asset}")
    write_cached_sha(dest, expected)
    return dest


def main() -> None:
    binary = ensure_binary()
    raise SystemExit(subprocess.call([str(binary), *sys.argv[1:]]))
