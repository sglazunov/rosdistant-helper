#!/usr/bin/env bash
# Builds a Safari App Extension from the Chromium build.
#
# REQUIRES macOS with Xcode + command-line tools — Safari extensions cannot be
# built on Windows or Linux. Run on a Mac:
#
#   npm run build            # produces dist/chrome
#   bash scripts/build-safari.sh
#
# This wraps Apple's official converter, then opens the generated Xcode project.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v xcrun >/dev/null 2>&1; then
	echo "xcrun not found. This script must run on macOS with Xcode installed." >&2
	exit 1
fi

if [ ! -d dist/chrome ]; then
	echo "dist/chrome not found — run 'npm run build' first." >&2
	exit 1
fi

OUT="safari"
rm -rf "$OUT"
xcrun safari-web-extension-converter dist/chrome \
	--app-name "Rosdistant Helper" \
	--bundle-identifier "ru.rosdistant.helper" \
	--project-location "$OUT" \
	--no-prompt --macos-only

echo
echo "Safari project created in ./$OUT"
echo "Open the .xcodeproj in Xcode, set a signing team, then Run."
echo "Enable it in Safari → Settings → Extensions (turn on 'Allow unsigned extensions' in the Develop menu for local testing)."
