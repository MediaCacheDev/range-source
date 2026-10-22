#!/bin/bash
#
# publish-android.sh [local|central]
#
# Builds the Android library in android/ and publishes it as dev.mediacache:range-source:<version>,
# the version in android/build.gradle, with its Media3 adapter dev.mediacache:range-source-media3
# (android/media3). Publish it before the players, which depend on it.
#
#   local    publishToMavenLocal (~/.m2), unsigned unless a key is set. The default.
#   central  signs, bundles and uploads to the Maven Central Portal. Needs:
#              ORG_GRADLE_PROJECT_mavenCentralUsername / …Password   Central Portal user token
#              ORG_GRADLE_PROJECT_signingInMemoryKey                 armored secret key
#              ORG_GRADLE_PROJECT_signingInMemoryKeyPassword
#              ORG_GRADLE_PROJECT_signingInMemoryKeyId               optional
#            The deployment waits in the portal for you to press Publish, unless
#            PUBLISHING_TYPE=AUTOMATIC.
#

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GRADLE_DIR="$ROOT_DIR/android"
MODE="${1:-local}"
VERSION="$(sed -n "s/^version = '\(.*\)'/\1/p" "$GRADLE_DIR/build.gradle")"
GRADLE=("$GRADLE_DIR/gradlew" -p "$GRADLE_DIR" -q)

if [ -z "$VERSION" ]; then
    echo "❌ No version = '…' line in android/build.gradle"
    exit 1
fi

case "$MODE" in
    local)
        "${GRADLE[@]}" publishToMavenLocal
        echo "✅ dev.mediacache:range-source and range-source-media3 $VERSION in ~/.m2/repository"
        ;;
    central)
        for var in ORG_GRADLE_PROJECT_mavenCentralUsername ORG_GRADLE_PROJECT_mavenCentralPassword \
                   ORG_GRADLE_PROJECT_signingInMemoryKey ORG_GRADLE_PROJECT_signingInMemoryKeyPassword; do
            if [ -z "${!var:-}" ]; then
                echo "❌ $var is not set"
                exit 1
            fi
        done

        STAGING="$GRADLE_DIR/build/staging-repo"
        rm -rf "$STAGING"
        "${GRADLE[@]}" publishReleasePublicationToStagingRepository

        VERSION_DIRS=()
        for artifact in range-source range-source-media3; do
            VERSION_DIRS+=("dev/mediacache/$artifact/$VERSION")
        done
        for dir in "${VERSION_DIRS[@]}"; do
            if ! ls "$STAGING/$dir"/*.aar.asc > /dev/null 2>&1; then
                echo "❌ $dir was not signed"
                exit 1
            fi
        done

        BUNDLE="$GRADLE_DIR/build/range-source-$VERSION-bundle.zip"
        rm -f "$BUNDLE"
        (cd "$STAGING" && zip -qr "$BUNDLE" "${VERSION_DIRS[@]}")
        echo "📦 $BUNDLE"
        unzip -l "$BUNDLE" | awk 'NR > 3 { print "   " $4 }' | sed '/^   $/d'

        TOKEN="$(printf '%s:%s' "$ORG_GRADLE_PROJECT_mavenCentralUsername" "$ORG_GRADLE_PROJECT_mavenCentralPassword" | base64 | tr -d "\n")"
        DEPLOYMENT_ID="$(curl --fail-with-body -sS \
            -H "Authorization: Bearer $TOKEN" \
            -F "bundle=@$BUNDLE" \
            "https://central.sonatype.com/api/v1/publisher/upload?name=range-source-$VERSION&publishingType=${PUBLISHING_TYPE:-USER_MANAGED}")"
        echo "⬆️  Uploaded, deployment $DEPLOYMENT_ID"
        echo "   Watch https://central.sonatype.com/publishing/deployments"
        ;;
    *)
        echo "Usage: $0 [local|central]"
        exit 1
        ;;
esac
