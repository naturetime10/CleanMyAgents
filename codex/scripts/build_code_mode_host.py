#!/usr/bin/env python3
"""Build `codex-code-mode-host` against Codex's sandboxed V8 artifacts.

`rusty_v8` publishes no `ptrcomp_sandbox` prebuilt for any platform, so a plain
`cargo build -p codex-code-mode-host` fails on every target that enables V8's
in-process sandbox: the crate's build script tries to download an archive that
was never released. Bazel consumer builds sidestep this by source-building V8;
CI Cargo builds instead point `RUSTY_V8_ARCHIVE` and `RUSTY_V8_SRC_BINDING_PATH`
at Codex's own release assets (see `.github/actions/setup-rusty-v8`).

This does the same thing for a local checkout, so a developer gets a host binary
with the sandbox enabled rather than one built with it turned off.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CARGO_ROOT = REPO_ROOT / "codex-rs"
PROFILE = "ptrcomp_sandbox_release"


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, **kwargs)


def host_target() -> str:
    """The triple rustc will build for, which selects the V8 asset."""
    out = subprocess.run(
        ["rustc", "-vV"], check=True, capture_output=True, text=True
    ).stdout
    for line in out.splitlines():
        if line.startswith("host: "):
            return line.removeprefix("host: ").strip()
    raise SystemExit("could not determine the host target from `rustc -vV`")


def v8_version() -> str:
    out = subprocess.run(
        [sys.executable, str(REPO_ROOT / ".github/scripts/rusty_v8_bazel.py"),
         "resolved-v8-crate-version"],
        check=True, capture_output=True, text=True,
    ).stdout
    return out.strip().splitlines()[-1]


def fetch(url: str, dest: Path) -> None:
    if dest.exists():
        return
    print(f"  downloading {dest.name}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url) as response, tmp.open("wb") as out:
        while chunk := response.read(1 << 20):
            out.write(chunk)
    tmp.replace(dest)


def verify(checksums: Path) -> None:
    """Check the downloads against the published manifest, as CI does."""
    for line in checksums.read_text().replace("\r", "").splitlines():
        if not line.strip():
            continue
        expected, name = line.split()
        target = checksums.parent / name
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        if digest != expected:
            raise SystemExit(f"checksum mismatch for {name}")
        print(f"  verified {name}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", action="store_true", help="build with --release")
    parser.add_argument("cargo_args", nargs="*", help="extra args passed to cargo build")
    args = parser.parse_args()

    target = host_target()
    version = v8_version()
    base = f"https://github.com/openai/codex/releases/download/rusty-v8-v{version}"
    suffix = "lib.gz" if target.endswith("-pc-windows-msvc") else "a.gz"
    archive_name = (
        f"rusty_v8_{PROFILE}_{target}.{suffix}"
        if suffix == "lib.gz"
        else f"librusty_v8_{PROFILE}_{target}.{suffix}"
    )
    binding_name = f"src_binding_{PROFILE}_{target}.rs"
    checksums_name = f"rusty_v8_{PROFILE}_{target}.sha256"

    # Lives under `target/` so it is already ignored and a `cargo clean` simply
    # means the next run downloads again.
    cache = CARGO_ROOT / "target" / "rusty_v8" / version
    print(f"rusty_v8 {version} for {target}")
    for name in (archive_name, binding_name, checksums_name):
        fetch(f"{base}/{name}", cache / name)
    verify(cache / checksums_name)

    cmd = ["cargo", "build", "-p", "codex-code-mode-host", "--bin", "codex-code-mode-host"]
    if args.release:
        cmd.append("--release")
    cmd += args.cargo_args
    print(f"  {' '.join(cmd)}")
    run(cmd, cwd=CARGO_ROOT, env={
        **os.environ,
        "RUSTY_V8_ARCHIVE": str(cache / archive_name),
        "RUSTY_V8_SRC_BINDING_PATH": str(cache / binding_name),
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
