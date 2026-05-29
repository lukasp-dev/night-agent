#!/usr/bin/env bash
set -euo pipefail

to_posix_path() {
  local input="$1"
  if [[ -z "$input" ]]; then
    echo ""
    return
  fi

  if command -v cygpath >/dev/null 2>&1; then
    local converted
    converted="$(cygpath -u "$input" 2>/dev/null || true)"
    if [[ -n "$converted" ]]; then
      echo "$converted"
      return
    fi
  fi

  if [[ "$input" =~ ^([A-Za-z]):\\(.*)$ ]]; then
    local drive
    local rest
    drive="$(echo "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')"
    rest="${BASH_REMATCH[2]//\\//}"
    echo "/mnt/${drive}/${rest}"
    return
  fi

  if [[ "$input" =~ ^([A-Za-z]):/(.*)$ ]]; then
    local drive
    local rest
    drive="$(echo "${BASH_REMATCH[1]}" | tr '[:upper:]' '[:lower:]')"
    rest="${BASH_REMATCH[2]}"
    echo "/mnt/${drive}/${rest}"
    return
  fi

  echo "$input"
}

repo_path_raw="${AGENT_REPO_PATH:-}"
repo_path="$(to_posix_path "$repo_path_raw")"

if [[ -z "$repo_path" ]]; then
  echo "AGENT_REPO_PATH is required." >&2
  exit 1
fi

context_file="${repo_path}/AGENT_BACKEND_CONTEXT.md"
skill_file="${AGENT_CONFIG_DIR:-}/skills/backend-review-prior-start.md"
app_file="${repo_path}/src/main/resources/application.yml"
local_file="${repo_path}/src/main/resources/application-local.yml"
compose_file="${repo_path}/docker-compose.yml"

echo "## Backend preflight"
echo "Repository: ${AGENT_REPO_NAME:-backend}"
echo "Path: ${repo_path_raw}"
echo

if [[ -f "$context_file" ]]; then
  echo "### Agent backend context"
  cat "$context_file"
  echo
else
  echo "### Agent backend context"
  echo "AGENT_BACKEND_CONTEXT.md not found."
  echo
fi

if [[ -f "$skill_file" ]]; then
  echo "### Skill: backend-review-prior-start"
  cat "$skill_file"
  echo
fi

echo "### Verified datasource snippets"
for file in "$app_file" "$local_file" "$compose_file"; do
  if [[ -f "$file" ]]; then
    rel="${file#${repo_path}/}"
    echo "--- ${rel} ---"
    grep -nE "spring:|datasource:|url: jdbc:|username:|password:|driver-class-name:|ddl-auto:|dialect:|SPRING_DATASOURCE_" "$file" || true
    echo
  fi
done
