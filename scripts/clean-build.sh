#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

rm -f -- "$repo_root/bin/interviewer"
rm -rf -- "$repo_root/.cache/go-build"
rm -rf -- "$repo_root/web/tests/.compiled"

printf 'Removed only bin/interviewer, .cache/go-build, and web/tests/.compiled.\n'
