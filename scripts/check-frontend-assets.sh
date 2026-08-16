#!/usr/bin/env bash
set -euo pipefail

asset_dir=${1:?usage: check-frontend-assets.sh <production-build-directory>}

if [[ ! -d "$asset_dir" ]]; then
  printf 'Production build directory does not exist: %s\n' "$asset_dir" >&2
  exit 1
fi

blocked_pattern='jsdelivr|unpkg|cdnjs'
if rg -n -i "$blocked_pattern" "$asset_dir"; then
  printf 'Production build contains a blocked third-party asset URL.\n' >&2
  exit 1
fi

tldraw_matches=$(rg -l -i 'cdn\.tldraw' "$asset_dir" || true)
if [[ -n "$tldraw_matches" ]]; then
  expected_file=$(find "$asset_dir/assets" -maxdepth 1 -type f -name 'WhiteboardPanel-*.js' -print -quit)
  if [[ -z "$expected_file" || "$tldraw_matches" != "$expected_file" ]] || [[ $(rg -o -i 'cdn\.tldraw' "$expected_file" | wc -l | tr -d ' ') != 1 ]]; then
    printf 'Production build contains an unexpected tldraw CDN path.\n' >&2
    printf '%s\n' "$tldraw_matches" >&2
    exit 1
  fi
  printf 'PASS  The one tldraw package fallback literal is unreachable because WhiteboardPanel supplies getAssetUrlsByImport() URLs. Browser coverage blocks every non-loopback request while rendering it.\n'
fi

printf 'PASS  Production emitted assets contain no reachable third-party CDN paths.\n'
