#!/usr/bin/env sh
# Reject a commit subject release-please cannot parse.
#
# Kept deliberately small: it validates the shape (`type(scope)!: subject`), not
# the semantics, because the semantic decision belongs to the reviewer. Squash
# merge messages are validated too, which is why merge commits are exempt.
set -eu

message_file="$1"
subject=$(head -n 1 "$message_file")

# Merge commits and reverts are produced by git, not by a human.
case "$subject" in
  Merge*|Revert*|fixup!*|squash!*)
    exit 0
    ;;
esac

pattern='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9 ._/-]+\))?!?: .+'

if printf '%s' "$subject" | grep -Eq "$pattern"; then
  exit 0
fi

cat >&2 <<EOF
✖ The commit subject is not a Conventional Commit.

  got:      $subject
  expected: <type>(<scope>)!: <subject>

  types: feat fix docs style refactor perf test build ci chore revert

Examples:
  feat(plugin): resolve the taxpayer from the organization
  fix(persistence): refuse a retry while a submission is pending
  docs: document certificate rotation

See CONTRIBUTING.md §Commits and releases.
EOF
exit 1
