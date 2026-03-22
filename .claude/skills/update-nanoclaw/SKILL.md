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

Other channel remotes (whatsapp, slack, discord, etc.) may also exist and merge into `main`.

## Known auto-resolvable conflicts

- **`package-lock.json`**: always take theirs (`git checkout --theirs package-lock.json && git add package-lock.json`), then `npm install --legacy-peer-deps` regenerates it.

## Files that need manual review if conflicted

- **`package.json`**: may contain local dependencies not in upstream. Merge carefully — do not silently take theirs.
- **`src/channels/telegram.ts`**: heavily customized with voice transcription. Preserve custom code.

## Rollback

```
git checkout custom && git reset --hard pre-update-<hash>-<timestamp>
git checkout main && git reset --hard pre-update-main-<hash>-<timestamp>
```

## Token usage

Only opens files with actual conflicts. Uses `git log`, `git diff`, and `git status` for everything else. Does not scan or refactor unrelated code.

---

# Goal
Safely sync upstream NanoClaw changes into the two-branch fork (main → custom) without losing personal customizations.

# Operating principles
- Never proceed with a dirty working tree.
- Always create rollback points for BOTH `main` and `custom` before touching anything.
- The `main` branch must stay clean — only upstream/channel merges, no personal code. If conflicts appear on main, something is wrong — warn the user.
- The `custom` branch is the deploy target — all personal modifications live here.
- Auto-resolve only `package-lock.json`. All other conflicts require review.
- Prefer git-native operations. Do not manually rewrite files except conflict markers.
- Keep token usage low: rely on `git status`, `git log`, `git diff`, and open only conflicted files.

# Step 0: Preflight

Check working tree is clean:
- `git status --porcelain`
- If non-empty: tell the user to commit or stash first, then stop.

Verify current branch:
- `git branch --show-current`
- Must be on `custom`. If not, tell user and stop.

Verify `custom` and `main` branches exist:
- `git branch --list main custom`
- If either is missing, warn and stop.

Confirm remotes:
- `git remote -v`
- If `upstream` is missing: `git remote add upstream https://github.com/qwibitai/nanoclaw.git`
- If `origin` is not `thepetshark/nanoclaw`: warn the user.

Fetch all remotes:
- `git fetch upstream --prune`
- `git fetch origin --prune`
- For each channel remote (telegram, whatsapp, etc.): `git fetch <remote> --prune`

# Step 1: Create safety nets

Capture current state on BOTH branches:
- `CUSTOM_HASH=$(git rev-parse --short custom)`
- `MAIN_HASH=$(git rev-parse --short main)`
- `TIMESTAMP=$(date +%Y%m%d-%H%M%S)`

Create backup branches and tags for both:
- `git branch backup/pre-update-$CUSTOM_HASH-$TIMESTAMP custom`
- `git tag pre-update-$CUSTOM_HASH-$TIMESTAMP custom`
- `git branch backup/pre-update-main-$MAIN_HASH-$TIMESTAMP main`
- `git tag pre-update-main-$MAIN_HASH-$TIMESTAMP main`

Save both tag names for rollback instructions.

# Step 2: Preview upstream changes

Compute base between local main and upstream:
- `BASE=$(git merge-base main upstream/main)`

Show upstream commits since last sync:
- `git log --oneline $BASE..upstream/main`

If no new commits: tell user "`main` is already up to date with upstream."

Check for pending channel remote updates too:
- For each channel remote, check: `git log --oneline main..<remote>/main | head -5`
- If any have new commits, list them: "Channel remote `<name>` has N new commits."

If nothing new from upstream or channel remotes: ask if user wants to continue (they may want to re-merge main into custom) or abort.

Show file-level impact from upstream:
- `git diff --name-only $BASE..upstream/main`

Bucket the changed files:
- **Skills** (`.claude/skills/`): unlikely to conflict unless user edited an upstream skill
- **Source** (`src/`): may conflict with custom modifications
- **Build/config** (`package.json`, `package-lock.json`, `tsconfig*.json`, `container/`): review needed
- **Other**: docs, tests, misc

Present buckets and ask the user to choose using AskUserQuestion:
- A) **Full update**: merge all upstream changes (default)
- B) **Selective update**: cherry-pick specific upstream commits
- C) **Abort**: just view the changelog, change nothing

If Abort: stop here.

# Step 3: Conflict preview

Preview conflicts using a dry-run merge on main. Run as a single chained command so the abort always executes:
```
git checkout main && git merge --no-commit --no-ff upstream/main 2>&1; echo "---CONFLICTS---"; git diff --name-only --diff-filter=U 2>/dev/null; echo "---END---"; git merge --abort 2>/dev/null; git checkout custom
```

Parse the output between `---CONFLICTS---` and `---END---` for conflicted file names.

If conflicts detected:
- List the conflicted files.
- Note which are auto-resolvable (package-lock.json only).
- If `src/` files conflict: warn that `main` should be a clean upstream branch — conflicts here suggest accidental commits to main. Ask user if they want to investigate before proceeding.
- Ask user if they want to proceed.

If no conflicts: tell user it's clean and proceed.

# Step 4A: Merge upstream into main

Switch to main:
- `git checkout main`

Sanity check — main should be clean upstream. Check for local commits not in upstream:
- `git log upstream/main..main --oneline`
- If any commits exist that aren't merge commits: warn the user: "main has local commits that aren't in upstream. This branch should be clean. Investigate before proceeding?" Offer to continue or abort.

Merge upstream:
- `git merge upstream/main --no-edit`

If conflicts occur:
- **package-lock.json**: auto-resolve with `git checkout --theirs package-lock.json && git add package-lock.json`
- **package.json**: DO NOT auto-resolve. Open the file, resolve conflict markers carefully. Diff against backup tag to check if any local dependencies would be lost: `git diff pre-update-main-$MAIN_HASH-$TIMESTAMP..HEAD -- package.json`. Warn user of any removals.
- **Any src/ file conflicting on main**: this is unexpected — warn the user that main has diverged from upstream. Resolve by taking upstream (theirs) since main should be clean, but confirm with user first.
- **All other files**: resolve conflict markers, preferring upstream side (main should match upstream).
- When all resolved: `git commit --no-edit`

Also merge pending channel remotes if any were detected in Step 2:
- For each channel remote with new commits:
  - `git merge <remote>/main --no-edit`
  - Apply same conflict resolution rules.
  - If package-lock.json conflicts: `git checkout --theirs package-lock.json && git add package-lock.json`

# Step 4B: Selective update (CHERRY-PICK onto main)

If user chose Selective:
- `git checkout main`
- Show commit list: `git log --oneline $BASE..upstream/main`
- Ask user which commit hashes they want.
- `git cherry-pick <hash1> <hash2> ...`

If conflicts during cherry-pick:
- Apply same resolution rules as Step 4A.
- `git add <file>` then `git cherry-pick --continue`
If user wants to stop: `git cherry-pick --abort`

# Step 5: Merge main into custom

Switch to custom:
- `git checkout custom`
- `git merge main --no-edit`

If conflicts occur:
- **package-lock.json**: `git checkout --theirs package-lock.json && git add package-lock.json`
- **package.json**: merge carefully. Check for local dependencies in custom that aren't in main: `git diff main..custom -- package.json` (using backup). Preserve local additions, take upstream version bumps.
- **src/ files**: these are expected — custom has modifications. **Preserve custom modifications**. Incorporate upstream changes without losing personal customizations. When in doubt, keep the custom side and manually integrate the upstream change. Ask the user if unclear.
- **All other files**: resolve conflict markers. For files only modified on custom side, keep custom. For files only modified on main side, take main.
- Do not refactor surrounding code.
- `git add <file>`
- When all resolved: `git commit --no-edit`

If no conflicts: merge auto-completes.

# Step 6: Install and validate

Check if dependencies changed:
- `git diff pre-update-$CUSTOM_HASH-$TIMESTAMP..HEAD -- package.json package-lock.json`
- If either changed: `npm install --legacy-peer-deps`
- If neither changed: skip npm install.

Build and test:
- `npm run build`
- `npx vitest run` (report results but do not fail the flow if some tests fail)

If build fails:
- Show the error.
- Only fix issues clearly caused by the merge (missing imports, type mismatches).
- Do not refactor unrelated code.
- If unclear, ask the user.

Check if container files changed:
- `git diff pre-update-$CUSTOM_HASH-$TIMESTAMP..HEAD -- container/`
- If container files changed: run `./container/build.sh` and report result.
- If not changed: skip.

# Step 7: Breaking changes check

Diff CHANGELOG against the backup tag:
- `git diff pre-update-$CUSTOM_HASH-$TIMESTAMP..HEAD -- CHANGELOG.md`

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

# Step 9: Push to origin

Ask user using AskUserQuestion:
- Option 1: "Push both main and custom to origin"
- Option 2: "Push custom only"
- Option 3: "Don't push — I'll do it later"

If push selected:
- `git push origin main` (if selected)
- `git push origin custom`

# Step 10: Deploy

Ask user if they want to restart the service:
- Option 1: "Yes, restart nanoclaw now"
- Option 2: "No, I'll restart later"

If yes:
- `systemctl --user restart nanoclaw`
- Wait 2 seconds, then `systemctl --user status nanoclaw --no-pager | head -10`
- Confirm service is running.

# Step 11: Summary + rollback instructions

Show:
- Backup tags: `pre-update-$CUSTOM_HASH-$TIMESTAMP` (custom), `pre-update-main-$MAIN_HASH-$TIMESTAMP` (main)
- Previous HEAD (custom): the hash from Step 1
- New HEAD (custom): `git rev-parse --short HEAD`
- Main HEAD: `git rev-parse --short main`
- Upstream HEAD: `git rev-parse --short upstream/main`
- Channel remotes merged (list any)
- Conflicts resolved (list files, if any)
- Breaking changes applied (list skills run, if any)
- Dependencies updated: yes/no
- Container rebuilt: yes/no
- Service restarted: yes/no
- Pushed to origin: yes/no
- Remaining local diff vs upstream: `git diff --name-only upstream/main..HEAD`

Rollback instructions:
```bash
# Rollback custom branch:
git checkout custom
git reset --hard pre-update-<CUSTOM_HASH>-<TIMESTAMP>

# Rollback main branch (if needed):
git checkout main
git reset --hard pre-update-main-<MAIN_HASH>-<TIMESTAMP>

# Switch back to custom and rebuild:
git checkout custom
npm run build
systemctl --user restart nanoclaw
```

Backup branches also exist:
- `backup/pre-update-<CUSTOM_HASH>-<TIMESTAMP>`
- `backup/pre-update-main-<MAIN_HASH>-<TIMESTAMP>`
