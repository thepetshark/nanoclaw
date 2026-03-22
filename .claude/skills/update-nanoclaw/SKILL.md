---
name: update-nanoclaw
description: Pull upstream NanoClaw updates into main, then merge main into custom. Two-branch workflow with automatic conflict resolution for known files.
---

# About

This NanoClaw install uses a two-branch workflow:
- **`main`** — clean upstream tracking branch. Only upstream and channel remote merges go here.
- **`custom`** — deployed branch with all personal modifications. Deployed via systemd.

This skill pulls upstream changes into `main`, then merges `main` into `custom`, handling known conflicts automatically.

Run `/update-nanoclaw` in Claude Code.

## Remotes

| Remote | URL | Purpose |
|--------|-----|---------|
| `origin` | `https://github.com/thepetshark/nanoclaw.git` | User's fork |
| `upstream` | `https://github.com/qwibitai/nanoclaw.git` | Upstream NanoClaw |
| `telegram` | `https://github.com/thepetshark/nanoclaw-telegram.git` | Telegram channel fork |

## Known auto-resolvable conflicts

These files always conflict on upstream merges and have standard resolutions:
- **`package-lock.json`**: always take theirs (`git checkout --theirs package-lock.json && git add package-lock.json`)
- **`package.json`**: take theirs, then verify no local dependencies were lost

## Rollback

The backup tag is printed at the end of each run:
```
git checkout custom && git reset --hard pre-update-<hash>-<timestamp>
```

## Token usage

Only opens files with actual conflicts. Uses `git log`, `git diff`, and `git status` for everything else. Does not scan or refactor unrelated code.

---

# Goal
Safely sync upstream NanoClaw changes into the two-branch fork (main → custom) without losing personal customizations.

# Operating principles
- Never proceed with a dirty working tree.
- Always create a rollback point (backup branch + tag) on `custom` before touching anything.
- The `main` branch must stay clean — only upstream/channel merges, no personal code.
- The `custom` branch is the deploy target — all personal modifications live here.
- Auto-resolve known conflict files (package-lock.json) without asking.
- Prefer git-native operations. Do not manually rewrite files except conflict markers.
- Keep token usage low: rely on `git status`, `git log`, `git diff`, and open only conflicted files.

# Step 0: Preflight

Check working tree is clean:
- `git status --porcelain`
- If non-empty: tell the user to commit or stash first, then stop.

Verify current branch:
- `git branch --show-current`
- Must be on `custom`. If not, tell user and stop.

Confirm remotes:
- `git remote -v`
- If `upstream` is missing: `git remote add upstream https://github.com/qwibitai/nanoclaw.git`
- If `origin` is not `thepetshark/nanoclaw`: warn the user.

Fetch all:
- `git fetch upstream --prune`
- `git fetch origin --prune`

# Step 1: Create a safety net

Capture current state (on `custom`):
- `HASH=$(git rev-parse --short HEAD)`
- `TIMESTAMP=$(date +%Y%m%d-%H%M%S)`

Create backup branch and tag:
- `git branch backup/pre-update-$HASH-$TIMESTAMP`
- `git tag pre-update-$HASH-$TIMESTAMP`

Save the tag name for rollback instructions.

# Step 2: Preview upstream changes

Compute base between local main and upstream:
- `git fetch upstream --prune`
- `BASE=$(git merge-base main upstream/main)`

Show upstream commits since last sync:
- `git log --oneline $BASE..upstream/main`

If no new commits: tell user "Already up to date" and stop.

Show file-level impact:
- `git diff --name-only $BASE..upstream/main`

Bucket the changed files:
- **Skills** (`.claude/skills/`): unlikely to conflict unless user edited an upstream skill
- **Source** (`src/`): may conflict with custom modifications
- **Build/config** (`package.json`, `package-lock.json`, `tsconfig*.json`, `container/`): auto-resolvable or review needed
- **Other**: docs, tests, misc

Present buckets and ask the user to choose using AskUserQuestion:
- A) **Full update**: merge all upstream changes (default)
- B) **Selective update**: cherry-pick specific upstream commits
- C) **Abort**: just view the changelog, change nothing

If Abort: stop here.

# Step 3: Conflict preview

Dry-run merge on main to preview conflicts:
- `git stash` (if needed)
- ```
  git checkout main
  git merge --no-commit --no-ff upstream/main; git diff --name-only --diff-filter=U; git merge --abort
  git checkout custom
  ```
- If conflicts listed: show them and note which are auto-resolvable (package-lock.json).
- Ask user if they want to proceed.

# Step 4A: Merge upstream into main

Switch to main and merge:
- `git checkout main`
- `git merge upstream/main --no-edit`

If conflicts occur:
- **package-lock.json**: auto-resolve with `git checkout --theirs package-lock.json && git add package-lock.json`
- **package.json**: take theirs, then verify no local dependencies were dropped. Auto-resolve: `git checkout --theirs package.json && git add package.json`
- **All other files**: open only the conflicted file, resolve conflict markers, preserve upstream intent (main should be clean upstream). `git add <file>`
- When all resolved: `git commit --no-edit`

# Step 4B: Selective update (CHERRY-PICK onto main)

If user chose Selective:
- `git checkout main`
- Show commit list: `git log --oneline $BASE..upstream/main`
- Ask user which commit hashes they want.
- `git cherry-pick <hash1> <hash2> ...`

If conflicts during cherry-pick:
- Apply same auto-resolution rules as Step 4A.
- `git add <file>` then `git cherry-pick --continue`
If user wants to stop: `git cherry-pick --abort`

# Step 5: Merge main into custom

Switch to custom and merge main:
- `git checkout custom`
- `git merge main --no-edit`

If conflicts occur:
- **package-lock.json**: `git checkout --theirs package-lock.json && git add package-lock.json`
- **Other files**: open the conflicted file, resolve markers. **Preserve custom modifications** — upstream changes should be incorporated without losing personal customizations.
- Do not refactor surrounding code.
- `git add <file>`
- When all resolved: `git commit --no-edit`

If no conflicts: merge auto-completes.

# Step 6: Install and validate

Run:
- `npm install --legacy-peer-deps`
- `npm run build`
- `npx vitest run` (do not fail the flow if some tests fail — report results)

If build fails:
- Show the error.
- Only fix issues clearly caused by the merge (missing imports, type mismatches).
- Do not refactor unrelated code.
- If unclear, ask the user.

Check if container files changed:
- `git diff --name-only pre-update-$HASH-$TIMESTAMP..HEAD -- container/`
- If container files changed: run `./container/build.sh` and report result.

# Step 7: Breaking changes check

Diff CHANGELOG against the backup tag:
- `git diff pre-update-$HASH-$TIMESTAMP..HEAD -- CHANGELOG.md`

Parse for lines starting with `+[BREAKING]`. Format:
```
[BREAKING] <description>. Run `/<skill-name>` to <action>.
```

If no `[BREAKING]` lines: skip silently, proceed to Step 8.

If breaking changes found:
- Display warning header.
- For each breaking change, display the full description.
- Use AskUserQuestion to ask which migration skills to run.
- For each selected skill, invoke it.

# Step 8: Check for skill updates

Check for upstream skill branches:
- `git branch -r --list 'upstream/skill/*'`

If any exist:
- Ask user: "Upstream has skill branches. Check for skill updates?"
- If yes: invoke `/update-skills`

# Step 9: Deploy

Ask user if they want to restart the service:
- Option 1: "Yes, restart nanoclaw now"
- Option 2: "No, I'll restart later"

If yes:
- `systemctl --user restart nanoclaw`
- Wait 2 seconds, then `systemctl --user status nanoclaw --no-pager | head -10`
- Confirm service is running.

# Step 10: Summary + rollback instructions

Show:
- Backup tag: `pre-update-$HASH-$TIMESTAMP`
- Previous HEAD (custom): the hash from Step 1
- New HEAD (custom): `git rev-parse --short HEAD`
- Main HEAD: `git rev-parse --short main`
- Upstream HEAD: `git rev-parse --short upstream/main`
- Conflicts resolved (list files, if any)
- Breaking changes applied (list skills run, if any)
- Container rebuilt: yes/no
- Service restarted: yes/no
- Remaining local diff vs upstream: `git diff --name-only upstream/main..HEAD`

Rollback instructions:
```
git checkout custom
git reset --hard pre-update-<HASH>-<TIMESTAMP>
npm run build
systemctl --user restart nanoclaw
```

Backup branch also exists: `backup/pre-update-<HASH>-<TIMESTAMP>`
