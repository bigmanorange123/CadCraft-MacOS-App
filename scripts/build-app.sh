#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${1:-$ROOT/dist/CadCraft Connect.app}"
OUTPUT="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$OUTPUT")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

case "$OUTPUT" in
  "$ROOT"/dist/*.app) ;;
  *) echo "Output must be an .app bundle inside $ROOT/dist." >&2; exit 1 ;;
esac

NODE_BIN="${BUNDLED_NODE:-$(command -v node || true)}"
CLOUDFLARED_BIN="${BUNDLED_CLOUDFLARED:-$(command -v cloudflared || true)}"
APP_VERSION="${APP_VERSION:-0.1.0}"
if [[ ! "$APP_VERSION" =~ ^[0-9]+(\.[0-9]+){1,2}$ ]]; then
  echo "APP_VERSION must be a numeric dotted version such as 1.2.3." >&2
  exit 1
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js 20.19 or newer is required to build the app. Set BUNDLED_NODE to a compatible binary." >&2
  exit 1
fi
if [[ -z "$CLOUDFLARED_BIN" || ! -x "$CLOUDFLARED_BIN" ]]; then
  echo "cloudflared is required to build the app. Set BUNDLED_CLOUDFLARED to its binary." >&2
  exit 1
fi

NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node.split(".").slice(0, 2).map(Number).join(".")')"
if ! "$NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 19) ? 0 : 1)'; then
  echo "Node.js 20.19 or newer is required to build the app (found $NODE_VERSION)." >&2
  exit 1
fi
ARCH="${TARGET_ARCH:-$(uname -m)}"
case "$ARCH" in
  arm64) SWIFT_TRIPLE="arm64-apple-macosx13.0" ;;
  x86_64) SWIFT_TRIPLE="x86_64-apple-macosx13.0" ;;
  *) echo "TARGET_ARCH must be arm64 or x86_64." >&2; exit 1 ;;
esac
for BINARY in "$NODE_BIN" "$CLOUDFLARED_BIN"; do
  if ! lipo -archs "$BINARY" | tr ' ' '\n' | grep -qx "$ARCH"; then
    echo "$BINARY does not contain a $ARCH slice." >&2
    exit 1
  fi
done

CONNECT="$WORK/connect"
mkdir -p "$CONNECT" "$(dirname "$OUTPUT")"
cp "$ROOT/cadcraft-connect/package.json" "$ROOT/cadcraft-connect/package-lock.json" "$CONNECT/"
cp -R "$ROOT/cadcraft-connect/src" "$CONNECT/src"
cp "$ROOT/cadcraft-connect/tsconfig.json" "$CONNECT/"
(cd "$CONNECT" && npm ci --ignore-scripts --no-audit --no-fund && npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund)

APP="$OUTPUT"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/connect/bin"
cp "$ROOT/Recources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
swift build --package-path "$ROOT" --triple "$SWIFT_TRIPLE" -c release --product CadCraftConnect
swift build --package-path "$ROOT" --triple "$SWIFT_TRIPLE" -c release --product CadCraftConnectUpdater
SWIFT_BIN_DIR="$(swift build --package-path "$ROOT" --triple "$SWIFT_TRIPLE" -c release --show-bin-path)"
cp "$SWIFT_BIN_DIR/CadCraftConnect" "$APP/Contents/MacOS/CadCraftConnect"
mkdir -p "$APP/Contents/Helpers"
cp "$SWIFT_BIN_DIR/CadCraftConnectUpdater" "$APP/Contents/Helpers/CadCraftConnectUpdater"
cp -R "$CONNECT/dist" "$CONNECT/node_modules" "$APP/Contents/Resources/connect/"
cp -L "$NODE_BIN" "$APP/Contents/Resources/connect/bin/node"
cp -L "$CLOUDFLARED_BIN" "$APP/Contents/Resources/connect/bin/cloudflared"
chmod 755 "$APP/Contents/Helpers/CadCraftConnectUpdater" "$APP/Contents/Resources/connect/bin/node" "$APP/Contents/Resources/connect/bin/cloudflared"
lipo -archs "$APP/Contents/MacOS/CadCraftConnect" | tr ' ' '\n' | grep -qx "$ARCH"
lipo -archs "$APP/Contents/Helpers/CadCraftConnectUpdater" | tr ' ' '\n' | grep -qx "$ARCH"

python3 - "$APP/Contents/Resources/connect/bin/node" "$NODE_BIN" <<'PYTHON'
import re
import shutil
import subprocess
import sys
from pathlib import Path

node = Path(sys.argv[2]).resolve()
bundled_node = Path(sys.argv[1])
bundle_bin = Path(sys.argv[1]).parent

def run(*args):
    return subprocess.check_output(args, text=True)

def dependencies(binary):
    lines = run("otool", "-L", str(binary)).splitlines()[1:]
    return [line.strip().split(" (", 1)[0] for line in lines if line.strip()]

def rpaths(binary):
    lines = run("otool", "-l", str(binary)).splitlines()
    result = []
    for index, line in enumerate(lines):
        if line.strip() == "cmd LC_RPATH":
            match = re.search(r"path (.+?) \(offset", lines[index + 2].strip())
            if match:
                result.append(match.group(1))
    return result

def expand(path, binary):
    if path.startswith("@loader_path/"):
        return [binary.parent / path.removeprefix("@loader_path/")]
    if path.startswith("@executable_path/"):
        return [node.parent / path.removeprefix("@executable_path/")]
    if path.startswith("@rpath/"):
        name = path.removeprefix("@rpath/")
        candidates = []
        for rpath in rpaths(binary):
            if rpath.startswith("@loader_path/"):
                candidates.append(binary.parent / rpath.removeprefix("@loader_path/") / name)
            elif rpath.startswith("@executable_path/"):
                candidates.append(node.parent / rpath.removeprefix("@executable_path/") / name)
            else:
                candidates.append(Path(rpath) / name)
        return candidates
    return [Path(path)]

def system_library(path):
    return path.startswith("/System/Library/") or path.startswith("/usr/lib/")

queue = [node]
copied = {}
visited = set()
while queue:
    binary = queue.pop()
    if binary in visited:
        continue
    visited.add(binary)
    for dependency in dependencies(binary):
        if system_library(dependency):
            continue
        candidates = expand(dependency, binary)
        source = next((candidate.resolve() for candidate in candidates if candidate.exists()), None)
        if source is None:
            raise SystemExit(f"Could not resolve Node dependency {dependency} required by {binary}")
        destination = bundle_bin / source.name
        if source in copied:
            continue
        if destination.exists() and destination.resolve() != source:
            raise SystemExit(f"Two Node dependencies have the same filename: {source.name}")
        if not destination.exists():
            shutil.copy2(source, destination)
        copied[source] = destination
        if source not in visited:
            queue.append(source)

for source_binary, bundled_binary in [(node, bundled_node), *copied.items()]:
    for dependency in dependencies(source_binary):
        if not system_library(dependency):
            source = next(
                (candidate.resolve() for candidate in expand(dependency, source_binary) if candidate.exists()),
                None,
            )
            if source not in copied:
                raise SystemExit(f"Could not bundle Node dependency {dependency} required by {source_binary}")
            subprocess.check_call([
                "install_name_tool", "-change", dependency,
                f"@loader_path/{copied[source].name}", str(bundled_binary),
            ])
PYTHON

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>CadCraftConnect</string>
  <key>CFBundleIdentifier</key><string>com.bigmanorange.CadCraftConnect</string>
  <key>CFBundleName</key><string>CadCraft Connect</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>$APP_VERSION</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

if [[ -n "${SIGNING_IDENTITY:-}" ]]; then
  ENTITLEMENTS="$ROOT/scripts/distribution.entitlements"
  codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" --entitlements "$ENTITLEMENTS" "$APP/Contents/Resources/connect/bin/node"
  codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$APP/Contents/Helpers/CadCraftConnectUpdater"
  find "$APP/Contents/Resources/connect/bin" -maxdepth 1 -type f -name '*.dylib' -exec codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" {} \;
  codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" "$APP/Contents/Resources/connect/bin/cloudflared"
  codesign --force --options runtime --timestamp --sign "$SIGNING_IDENTITY" --entitlements "$ENTITLEMENTS" "$APP"
else
  codesign --force --sign - "$APP/Contents/Helpers/CadCraftConnectUpdater"
  codesign --force --deep --sign - "$APP"
fi

echo "Built $APP"
