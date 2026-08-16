#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
runtime_dir="$repo_root/runtime"

if [[ "${CONFIRM_PURGE_RUNTIME:-}" != "DELETE_RUNTIME" ]]; then
  printf 'Refusing to delete runtime data without CONFIRM_PURGE_RUNTIME=DELETE_RUNTIME.\n' >&2
  exit 1
fi
if [[ -L "$runtime_dir" ]]; then
  printf 'Refusing to delete a symbolic-link runtime path.\n' >&2
  exit 1
fi
if [[ "$runtime_dir" != "$repo_root/runtime" ]]; then
  printf 'Refusing to delete an unexpected path.\n' >&2
  exit 1
fi

rm -rf -- "$runtime_dir"
printf 'Deleted private interview data at %s. This cannot be recovered by the application.\n' "$runtime_dir"
