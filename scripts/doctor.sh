#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
errors=0

pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; errors=$((errors + 1)); }

configured_value() {
  local name=$1
  local value=""
  if [[ -n "${!name+x}" ]]; then
    value=${!name}
  elif [[ -f "$repo_root/.env" ]]; then
    value=$(awk -v key="$name" '
      /^[[:space:]]*#/ { next }
      {
        line=$0
        sub(/^[[:space:]]*/, "", line)
        prefix=key "="
        if (index(line, prefix) == 1) {
          print substr(line, length(prefix) + 1)
          exit
        }
      }
    ' "$repo_root/.env")
  fi
  value=${value%$'\r'}
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value=${value:1:${#value}-2}
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value=${value:1:${#value}-2}
  fi
  printf '%s' "$value"
}

version_at_least() {
  awk -v actual="$1" -v required="$2" 'BEGIN {
    split(actual, a, "."); split(required, r, ".")
    for (i = 1; i <= 3; i++) {
      current = a[i] + 0
      minimum = r[i] + 0
      if (current > minimum) exit 0
      if (current < minimum) exit 1
    }
    exit 0
  }'
}

if [[ -n "${DOCTOR_NODE_VERSION:-}" ]] || command -v node >/dev/null 2>&1; then
  node_version=${DOCTOR_NODE_VERSION:-$(node -p 'process.versions.node')}
  if version_at_least "$node_version" "22.12.0"; then
    pass "Node.js $node_version (22.12.0 or newer)"
  else
    fail "Node.js $node_version is older than 22.12.0"
  fi
else
  fail "Node.js is not installed"
fi

if [[ "${DOCTOR_ONLY_NODE_VERSION:-}" == "1" ]]; then
  if [[ $errors -ne 0 ]]; then exit 1; fi
  exit 0
fi

if command -v npm >/dev/null 2>&1; then
  npm_version=$(npm --version)
  if version_at_least "$npm_version" "9.0"; then
    pass "npm $npm_version (9 or newer)"
  else
    fail "npm $npm_version is older than 9"
  fi
else
  fail "npm is not installed"
fi

required_go=$(awk '$1 == "go" { print $2; exit }' "$repo_root/go.mod")
if command -v go >/dev/null 2>&1; then
  go_version=$(go env GOVERSION)
  go_version=${go_version#go}
  if version_at_least "$go_version" "$required_go"; then
    pass "Go $go_version (go.mod requires $required_go or newer)"
  else
    fail "Go $go_version is older than go.mod requirement $required_go"
  fi
else
  fail "Go is not installed"
fi

if [[ -f "$repo_root/web/package-lock.json" ]]; then
  pass "Frontend lockfile exists"
else
  fail "web/package-lock.json is missing"
fi

if [[ -d "$repo_root/web/node_modules" ]]; then
  if (cd "$repo_root/web" && npm ls --depth=0 --silent >/dev/null 2>&1); then
    pass "Frontend dependencies match the lockfile"
  else
    fail "Frontend dependencies are missing or invalid; run make install"
  fi
else
  fail "Frontend dependencies are missing; run make install"
fi

app_addr=$(configured_value APP_ADDR)
app_addr=${app_addr:-127.0.0.1:8080}
unsafe_bind=$(configured_value INTERVIEW_ALLOW_UNSAFE_NETWORK_BIND)
unsafe_bind=$(printf '%s' "$unsafe_bind" | tr '[:upper:]' '[:lower:]')
if ! grep -Fq 'address = "127.0.0.1:8080"' "$repo_root/cmd/server/main.go"; then
  fail "Server source no longer has the loopback 127.0.0.1:8080 fallback"
elif node -e '
  const net = require("node:net");
  try {
    const parsed = new URL(`http://${process.argv[1]}`);
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    const loopback = host.toLowerCase() === "localhost"
      || host === "::1"
      || (net.isIP(host) === 4 && host.startsWith("127."));
    process.exit(parsed.port && loopback ? 0 : 1);
  } catch {
    process.exit(1);
  }
' "$app_addr"; then
  pass "Server bind is loopback-only ($app_addr)"
elif [[ "$unsafe_bind" == "true" || "$unsafe_bind" == "1" || "$unsafe_bind" == "yes" ]]; then
  warn "Server bind is non-loopback ($app_addr) with explicit unsafe opt-in"
else
  fail "Server bind is non-loopback ($app_addr) without INTERVIEW_ALLOW_UNSAFE_NETWORK_BIND=true"
fi

runtime_dir="$repo_root/runtime"
if [[ -L "$runtime_dir" ]]; then
  fail "Runtime path must not be a symbolic link"
elif [[ -d "$runtime_dir" ]]; then
  if [[ -w "$runtime_dir" ]]; then
    pass "Runtime path is writable"
  else
    fail "Runtime path is not writable"
  fi
  if mode=$(stat -f '%Lp' "$runtime_dir" 2>/dev/null || stat -c '%a' "$runtime_dir" 2>/dev/null); then
    if (( (8#$mode & 077) == 0 )); then
      pass "Runtime directory permissions are owner-only ($mode)"
    else
      warn "Runtime directory mode is $mode; the server changes it to 700 before writes"
    fi
  else
    warn "Runtime directory permissions could not be read"
  fi
elif [[ -w "$repo_root" ]]; then
  pass "Runtime path can be created with owner-only permissions"
else
  fail "Repository is not writable, so runtime cannot be created"
fi

api_key=$(configured_value OPENAI_API_KEY)
case "$api_key" in
  ""|your_openai_api_key_here|replace_me|placeholder|sk-placeholder*)
    fail "OpenAI API key is missing or a placeholder; AI interviews cannot start"
    ;;
  *)
    pass "OpenAI API key is configured (value hidden)"
    ;;
esac
unset api_key

realtime_model=$(configured_value OPENAI_REALTIME_MODEL)
realtime_model=${realtime_model:-gpt-realtime-2.1-mini}
evaluation_model=$(configured_value OPENAI_EVALUATION_MODEL)
evaluation_model=${evaluation_model:-gpt-5.6-terra}
observer_model=$(configured_value OPENAI_OBSERVER_MODEL)
observer_model=${observer_model:-$evaluation_model}
orchestrator_model=$(configured_value OPENAI_ORCHESTRATOR_MODEL)
orchestrator_model=${orchestrator_model:-$evaluation_model}

for model_entry in \
  "Realtime:$realtime_model" \
  "Evaluation:$evaluation_model" \
  "Observer:$observer_model" \
  "Orchestrator:$orchestrator_model"; do
  model_label=${model_entry%%:*}
  model_name=${model_entry#*:}
  if [[ "$model_name" =~ ^[A-Za-z0-9._:-]+$ ]]; then
    pass "$model_label model: $model_name"
  else
    fail "$model_label model name is empty or malformed"
  fi
done

embedded_dir="$repo_root/cmd/server/webdist"
if [[ ! -f "$embedded_dir/index.html" ]]; then
  fail "Embedded frontend index is missing; run make build"
else
  missing_asset=0
  while IFS= read -r asset_path; do
    [[ -z "$asset_path" ]] && continue
    if [[ ! -f "$embedded_dir/${asset_path#/}" ]]; then
      fail "Embedded index references missing asset ${asset_path#/}"
      missing_asset=1
    fi
  done < <(grep -Eo '(src|href)="/assets/[^"]+"' "$embedded_dir/index.html" | cut -d'"' -f2)
  if [[ $missing_asset -eq 0 ]]; then
    pass "Embedded index references existing assets"
  fi

  if find "$embedded_dir/assets" -maxdepth 1 -type f -name 'editor.worker-*.js' -print -quit | grep -q . && \
     find "$embedded_dir/assets" -maxdepth 1 -type f -name 'ts.worker-*.js' -print -quit | grep -q .; then
    pass "Embedded Monaco workers are present"
  else
    fail "Embedded Monaco workers are missing; run make build"
  fi

  if find "$embedded_dir/assets" -maxdepth 1 -type f \( -name '*.woff2' -o -name '*.svg' \) -print -quit | grep -q .; then
    pass "Embedded tldraw assets are present"
  else
    fail "Embedded tldraw assets are missing; run make build"
  fi
fi

if [[ $errors -ne 0 ]]; then
  printf '\nDoctor found %d blocking problem(s).\n' "$errors" >&2
  exit 1
fi

printf '\nDoctor found no blocking problems.\n'
