#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
embedded_dir="$repo_root/cmd/server/webdist"
temp_base=${TMPDIR:-/tmp}
temp_dir=$(mktemp -d "$temp_base/interview-agent-web.XXXXXX")

cleanup() {
  case "$temp_dir" in
    "$temp_base"/interview-agent-web.*) rm -rf -- "$temp_dir" ;;
    *) printf 'Refusing to remove unexpected temporary path: %s\n' "$temp_dir" >&2 ;;
  esac
}
trap cleanup EXIT

if [[ ! -f "$embedded_dir/index.html" ]]; then
  printf 'Embedded frontend is missing. Run make build.\n' >&2
  exit 1
fi

(cd "$repo_root/web" && npm run build -- --outDir "$temp_dir")

if ! LC_ALL=C diff -qr "$temp_dir" "$embedded_dir"; then
  printf '\nEmbedded frontend is stale. Run make build, then retry.\n' >&2
  exit 1
fi

printf 'Embedded frontend matches a fresh production build.\n'
