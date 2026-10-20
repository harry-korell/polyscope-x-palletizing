#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
image_name="polyscope-x-palletizing-build:node24.11.1-npm10.9.1"
docker build --file "$project_root/tools/Dockerfile" --tag "$image_name" "$project_root/tools"
# Keep Linux node_modules in a Docker volume, including when sources are on NTFS.
docker run --rm \
  --mount "type=bind,source=$project_root,target=/workspace" \
  --mount type=volume,source=polyscope-x-palletizing-node-modules,target=/workspace/node_modules \
  --workdir /workspace \
  "$image_name" sh -c 'npm ci && npm run check'
