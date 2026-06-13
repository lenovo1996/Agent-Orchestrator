#!/usr/bin/env bash
# show-branches.sh - Display current branch for all repos

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Collect all repos first to calculate max width
declare -a repos branches statuses
max_repo_len=10
max_branch_len=6
status_content_len=11  # "uncommitted"
status_width=$((status_content_len + 2))

while IFS= read -r git_dir; do
  repo_dir="${git_dir%/.git}"
  repo_name="${repo_dir#$REPO_ROOT/}"
  
  # Skip root repo
  if [ "$repo_dir" = "$REPO_ROOT" ]; then
    continue
  fi
  
  cd "$repo_dir"
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "???")
  
  # Check if dirty (uncommitted changes)
  if git diff --quiet 2>/dev/null; then
    status=""
  else
    status="uncommitted"
  fi
  
  repos+=("$repo_name")
  branches+=("$branch")
  statuses+=("$status")
  
  # Track max lengths
  [ ${#repo_name} -gt $max_repo_len ] && max_repo_len=${#repo_name}
  [ ${#branch} -gt $max_branch_len ] && max_branch_len=${#branch}
done < <(find "$REPO_ROOT" -name .git -type d ! -path '*/.dev-team/*' | sort)

# Add padding
repo_width=$((max_repo_len + 2))
branch_width=$((max_branch_len + 2))

# Print table header
printf "┌"
printf '%0.s─' $(seq 1 $repo_width)
printf "┬"
printf '%0.s─' $(seq 1 $branch_width)
printf "┬"
printf '%0.s─' $(seq 1 $status_width)
printf "┐\n"

printf "│ %-${max_repo_len}s │ %-${max_branch_len}s │ %-${status_content_len}s │\n" "Repository" "Branch" "Status"

printf "├"
printf '%0.s─' $(seq 1 $repo_width)
printf "┼"
printf '%0.s─' $(seq 1 $branch_width)
printf "┼"
printf '%0.s─' $(seq 1 $status_width)
printf "┤\n"

# Print rows
for i in "${!repos[@]}"; do
  printf "│ %-${max_repo_len}s │ %-${max_branch_len}s │ %-${status_content_len}s │\n" "${repos[$i]}" "${branches[$i]}" "${statuses[$i]}"
done

printf "└"
printf '%0.s─' $(seq 1 $repo_width)
printf "┴"
printf '%0.s─' $(seq 1 $branch_width)
printf "┴"
printf '%0.s─' $(seq 1 $status_width)
printf "┘\n"
echo ""
