#!/bin/bash
#
# test-ios.sh
#
# Runs the iOS package's tests (ios/Tests/RangeSourceTests) on a simulator with xcodebuild.
# IOS_SIMULATOR names the simulator ("iPhone 16 Pro"); without it, a booted iPhone simulator is
# used, or else the first available one.
#

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -n "${IOS_SIMULATOR:-}" ]; then
    DESTINATION="platform=iOS Simulator,name=$IOS_SIMULATOR"
else
    IPHONES="$(xcrun simctl list devices available | grep 'iPhone' || true)"
    UDID="$( { grep 'Booted' <<< "$IPHONES" || true; echo "$IPHONES"; } | sed -nE 's/.*\(([0-9A-F-]{36})\).*/\1/p' | head -1)"
    if [ -z "$UDID" ]; then
        echo "❌ No iPhone simulator available: add one in Xcode, or set IOS_SIMULATOR"
        exit 1
    fi
    DESTINATION="platform=iOS Simulator,id=$UDID"
fi

cd "$ROOT_DIR"
xcodebuild test -scheme range-source -destination "$DESTINATION" -derivedDataPath .build/xcode
