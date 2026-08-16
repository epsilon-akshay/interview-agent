#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if DOCTOR_NODE_VERSION=20.19.0 DOCTOR_ONLY_NODE_VERSION=1 "$repo_root/scripts/doctor.sh" >/dev/null 2>&1; then
  printf 'Expected Node.js 20.x to fail the doctor version gate.\n' >&2
  exit 1
fi

DOCTOR_NODE_VERSION=22.12.0 DOCTOR_ONLY_NODE_VERSION=1 "$repo_root/scripts/doctor.sh" >/dev/null
DOCTOR_NODE_VERSION=22.12.1 DOCTOR_ONLY_NODE_VERSION=1 "$repo_root/scripts/doctor.sh" >/dev/null

printf 'Doctor Node.js version gate rejects 20.x and accepts 22.12+.\n'
