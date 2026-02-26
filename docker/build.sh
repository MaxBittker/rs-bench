#!/bin/bash
set -e

IMAGE_NAME="${IMAGE_NAME:-rs-agent-benchmark}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
FULL_IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"

PLATFORM="${PLATFORM:-linux/amd64}"
echo "Building Docker image: ${FULL_IMAGE} (platform: ${PLATFORM})"

cd "$(dirname "$0")"

# Copy skill_tracker.ts from shared/ (single source of truth)
cp ../shared/skill_tracker.ts skill_tracker.ts

if [ "$PUSH" = "1" ] || [ "$PUSH" = "true" ]; then
    # Build and push in one step (buildx with --push avoids loading
    # a foreign-arch image into the local daemon).
    docker buildx build --platform "${PLATFORM}" -t "${FULL_IMAGE}" --push .
    echo "Built and pushed: ${FULL_IMAGE}"
else
    docker buildx build --platform "${PLATFORM}" -t "${FULL_IMAGE}" --load .
    echo "Built: ${FULL_IMAGE}"
fi
