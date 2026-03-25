#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <package-dir> <package-name> <version> <dist-tag>" >&2
  exit 1
fi

PACKAGE_DIR="$1"
PACKAGE_NAME="$2"
VERSION="$3"
DIST_TAG="$4"
MAX_ATTEMPTS=5
SLEEP_SECONDS=15

if npm view "${PACKAGE_NAME}@${VERSION}" version >/dev/null 2>&1; then
  echo "${PACKAGE_NAME}@${VERSION} is already published; skipping."
  exit 0
fi

attempt=1
while (( attempt <= MAX_ATTEMPTS )); do
  echo "Publishing ${PACKAGE_NAME}@${VERSION} (attempt ${attempt}/${MAX_ATTEMPTS}) with dist-tag ${DIST_TAG}"

  if npm publish --access public --tag "${DIST_TAG}" "${PACKAGE_DIR}"; then
    echo "Published ${PACKAGE_NAME}@${VERSION}"
    exit 0
  fi

  if npm view "${PACKAGE_NAME}@${VERSION}" version >/dev/null 2>&1; then
    echo "${PACKAGE_NAME}@${VERSION} is visible after failed publish attempt; treating as success."
    exit 0
  fi

  if (( attempt == MAX_ATTEMPTS )); then
    echo "Failed to publish ${PACKAGE_NAME}@${VERSION} after ${MAX_ATTEMPTS} attempts." >&2
    exit 1
  fi

  echo "Publish failed; retrying in ${SLEEP_SECONDS}s..."
  sleep "${SLEEP_SECONDS}"
  attempt=$((attempt + 1))
done
