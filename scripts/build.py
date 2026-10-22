#!/usr/bin/env python3
"""Cross-build a local Queqiao checkout and create unsigned OpenWrt APKv3s."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]


def run(args, **kwargs):
    return subprocess.check_output([str(a) for a in args], text=True, **kwargs).strip()


def linux_path(path):
    path = Path(path).resolve()
    if os.name == "nt":
        return "/mnt/" + path.drive[0].lower() + path.as_posix()[2:]
    return str(path)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_digest(source):
    checksum = hashlib.sha256()
    names = subprocess.check_output(["git", "ls-files", "-z"], cwd=source).split(b"\0")
    for name in sorted(set(names) - {b""}):
        path = source / os.fsdecode(name)
        checksum.update(name + b"\0")
        checksum.update(path.read_bytes() if path.is_file() else b"<deleted>")
        checksum.update(b"\0")
    return checksum.hexdigest()


def patched_overlay(source, output):
    patch = ROOT / "patches/100-lan-ingress.patch"
    paths = re.findall(r"(?m)^\+\+\+ b/([^\t\n]+)", patch.read_text(encoding="utf-8"))
    if not paths or len(paths) > 16:
        raise RuntimeError("Invalid LAN patch file set")
    staged = output / "patched-core"
    staged.mkdir(exist_ok=True)
    mapping = {}
    for name in paths:
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts or relative.suffix != ".go" or not name.startswith(("cmd/queqiaod/", "internal/pep/")):
            raise RuntimeError("LAN patch contains an unsupported path")
        target = staged / name
        target.parent.mkdir(parents=True, exist_ok=True)
        original = source / name
        if original.is_file():
            target.write_bytes(original.read_bytes())
        elif target.exists():
            target.unlink()
        mapping[str(original)] = str(target)
    for mode in ["--check", "--apply"]:
        subprocess.run(["git", "apply", "--no-index", "--whitespace=error", mode, str(patch)], cwd=staged, check=True)
    return mapping, patch


def tar_payload(path, entries, epoch):
    # Normalize Windows modes, ownership, timestamps and ordering explicitly.
    directories = {"root", "scripts"}
    for name in entries:
        directories.update(str(p) for p in PurePosixPath(name).parents if str(p) != ".")
    with tarfile.open(path, "w", format=tarfile.USTAR_FORMAT) as archive:
        for name in sorted(directories):
            info = tarfile.TarInfo(name)
            info.type = tarfile.DIRTYPE
            info.mode = 0o700 if name == "root/etc/queqiao" else 0o755
            info.mtime = epoch
            archive.addfile(info)
        for name, (data, mode) in sorted(entries.items()):
            info = tarfile.TarInfo(name)
            info.mode, info.size, info.mtime = mode, len(data), epoch
            archive.addfile(info, io.BytesIO(data))


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--apk-tool", required=True, help="Linux path to apk with mkpkg support")
    parser.add_argument("--wsl", help="WSL distribution for Windows builds")
    parser.add_argument("--epoch", type=int, help="Fixed build timestamp; defaults to source commit time")
    args = parser.parse_args()
    source = args.source.resolve()
    output = ROOT / "dist"
    output.mkdir(exist_ok=True)
    module = (source / "go.mod").read_text(encoding="utf-8")
    go_version = re.search(r"(?m)^go (\S+)$", module).group(1)
    commit = run(["git", "rev-parse", "HEAD"], cwd=source)
    if run(["git", "ls-files", "--others", "--exclude-standard", "--", "*.go", "go.mod", "go.sum"], cwd=source):
        raise RuntimeError("Untracked Go source exists; track it before building provenance-bound packages")
    dirty = bool(run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=source))
    epoch = args.epoch if args.epoch is not None else int(run(["git", "show", "-s", "--format=%ct", "HEAD"], cwd=source))
    if epoch < 0:
        parser.error("epoch must be nonnegative")
    revision = commit[:12] + ("-dirty" if dirty else "")
    package_version = "0.10.0_git" + str(epoch) + "-r6"
    ui_version = "0.4.0-r1"
    env = dict(os.environ, GOOS="linux", GOARCH="arm64", CGO_ENABLED="0", GOTOOLCHAIN="go" + go_version)
    from datetime import datetime, timezone
    date = datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    flags = f"-s -w -X main.version={package_version} -X main.commit={revision} -X main.buildDate={date}"
    source_hash = source_digest(source)
    core_mapping, core_patch = patched_overlay(source, output)
    core_overlay = output / "core-overlay.json"
    core_overlay.write_text(json.dumps({"Replace": core_mapping}), encoding="utf-8")
    command = ["go", "build", "-trimpath", "-buildvcs=false", "-overlay", str(core_overlay), "-ldflags", flags, "-o", str(output / "queqiaod"), "./cmd/queqiaod"]
    subprocess.run(command, cwd=source, env=env, check=True)
    if source_digest(source) != source_hash or run(["git", "rev-parse", "HEAD"], cwd=source) != commit:
        raise RuntimeError("Source checkout changed during compilation; run the build again")
    helper_source = ROOT / "tools/profile/main.go"
    overlay = output / "profile-overlay.json"
    helper_sources = sorted((ROOT / "tools/profile").glob("*.go"))
    helper_mapping = {str(source / "cmd/queqiao-profile-editor" / path.name): str(path) for path in helper_sources}
    overlay.write_text(json.dumps({"Replace": {**core_mapping, **helper_mapping}}), encoding="utf-8")
    helper_command = ["go", "build", "-trimpath", "-buildvcs=false", "-overlay", str(overlay),
                      "-ldflags", "-s -w", "-o", str(output / "queqiao-profile"), "./cmd/queqiao-profile-editor"]
    subprocess.run(helper_command, cwd=source, env=env, check=True)
    if source_digest(source) != source_hash or run(["git", "rev-parse", "HEAD"], cwd=source) != commit:
        raise RuntimeError("Source checkout changed during helper compilation; run the build again")
    metadata = {
        "source_commit": commit, "source_dirty": dirty, "epoch": epoch,
        "tracked_source_sha256": source_hash,
        "go": run(["go", "version"], env=env), "target": "linux/arm64",
        "package_arch": "aarch64_cortex-a53", "wire_version": 1,
        "binary_sha256": digest(output / "queqiaod"),
        "profile_helper_sha256": digest(output / "queqiao-profile"),
        "profile_helper_source_sha256": digest(helper_source),
        "profile_helper_sources_sha256": {path.name: digest(path) for path in helper_sources},
        "core_patch_sha256": digest(core_patch),
        "go_mod_sha256": digest(source / "go.mod"), "go_sum_sha256": digest(source / "go.sum"),
        "build_command": ["dist/queqiaod" if part == str(output / "queqiaod") else "dist/core-overlay.json" if part == str(core_overlay) else part for part in command],
        "tracked_diff_sha256": hashlib.sha256(subprocess.check_output(["git", "diff", "HEAD", "--binary"], cwd=source)).hexdigest(),
        "unsigned_development_build": True,
    }
    modules_text = run(["go", "list", "-m", "-json", "all"], cwd=source, env=env)
    (output / "modules.json").write_text(modules_text + "\n", encoding="utf-8")
    (output / "BUILDINFO.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    core = {
        "root/usr/bin/queqiaod": ((output / "queqiaod").read_bytes(), 0o755),
        "root/usr/libexec/queqiao-profile": ((output / "queqiao-profile").read_bytes(), 0o755),
        "root/etc/config/queqiao": ((ROOT / "queqiao/files/queqiao.config").read_bytes(), 0o600),
        "root/etc/init.d/queqiao": ((ROOT / "queqiao/files/queqiao.init").read_bytes(), 0o755),
        "root/etc/queqiao/.keep": (b"", 0o600),
        "root/lib/upgrade/keep.d/queqiao": (b"/etc/config/queqiao\n/etc/queqiao/\n", 0o644),
        "root/lib/apk/packages/queqiao.conffiles": (b"/etc/config/queqiao\n/etc/queqiao/\n", 0o644),
        "root/lib/apk/packages/queqiao.conffiles_static": (("/etc/config/queqiao " + digest(ROOT / "queqiao/files/queqiao.config") + "\n").encode(), 0o644),
        "root/usr/share/queqiao/BUILDINFO.json": ((output / "BUILDINFO.json").read_bytes(), 0o644),
    }
    # Carry source and dependency license notices with the development binary.
    for name in ["LICENSE", "THIRD_PARTY_NOTICES.md"]:
        core["root/usr/share/licenses/queqiao/" + name] = ((source / name).read_bytes(), 0o644)
    core["root/usr/share/licenses/queqiao/congestion-NOTICE"] = ((source / "internal/congestion/NOTICE").read_bytes(), 0o644)
    decoder = json.JSONDecoder()
    remaining = modules_text.strip()
    while remaining:
        module_info, consumed = decoder.raw_decode(remaining)
        remaining = remaining[consumed:].lstrip()
        if module_info.get("Main") or "Dir" not in module_info:
            continue
        module_root = Path(module_info["Dir"])
        for path in sorted(module_root.iterdir()):
            if path.is_file() and path.name.upper().startswith(("LICENSE", "COPYING", "NOTICE")):
                name = "root/usr/share/licenses/queqiao/modules/" + module_info["Path"] + "/" + path.name
                core[name] = (path.read_bytes(), 0o644)
    ui = {}
    ui["root/usr/share/licenses/luci-app-queqiao/LICENSE"] = ((ROOT / "LICENSE").read_bytes(), 0o644)
    core["root/usr/share/licenses/queqiao/openwrt-LICENSE"] = ((ROOT / "LICENSE").read_bytes(), 0o644)
    for directory, prefix in [("root", "root"), ("htdocs", "root/www")]:
        for path in sorted((ROOT / "luci-app-queqiao" / directory).rglob("*")):
            if path.is_file():
                name = prefix + "/" + path.relative_to(ROOT / "luci-app-queqiao" / directory).as_posix()
                ui[name] = (path.read_bytes(), 0o755 if "/libexec/" in name else 0o644)
    packages = []
    for name, entries, version, arch, dependencies in [
        ("queqiao", core, package_version, "aarch64_cortex-a53", "libc ca-bundle"),
        ("luci-app-queqiao", ui, ui_version, "noarch", "queqiao luci-base rpcd jsonfilter"),
    ]:
        for script in ["post-install", "pre-deinstall"]:
            path = ROOT / name / "files" / script
            if path.exists():
                entries["scripts/" + script] = (path.read_bytes(), 0o755)
                if script == "post-install":
                    entries["scripts/post-upgrade"] = (path.read_bytes(), 0o755)
        files = sorted("/" + key.removeprefix("root/") for key in entries if key.startswith("root/"))
        entries[f"root/lib/apk/packages/{name}.list"] = (("\n".join(files) + f"\n/lib/apk/packages/{name}.list\n").encode(), 0o644)
        archive = output / (name + ".tar")
        tar_payload(archive, entries, epoch)
        apk_path = output / f"{name}-{version}.apk"
        command = ["/bin/sh", linux_path(ROOT / "scripts/pack.sh"), args.apk_tool,
                   linux_path(archive), linux_path(apk_path), name, version, arch, dependencies, str(epoch)]
        if args.wsl:
            command = ["wsl.exe", "-d", args.wsl, "-u", "root", "--exec"] + command
        subprocess.run(command, check=True)
        packages.append(apk_path)
        archive.unlink()
        print(apk_path)
    sums = "".join(digest(path) + "  " + path.name + "\n" for path in sorted(packages))
    (output / "SHA256SUMS").write_text(sums, encoding="utf-8")


if __name__ == "__main__":
    main()
