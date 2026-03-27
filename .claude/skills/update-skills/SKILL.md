---
name: update-skills
description: Check for and apply updates to installed skill branches from upstream.
---

# About

Skills are distributed as git branches (`skill/*`). When you install a skill, you merge its branch into your repo. This skill checks upstream for newer commits on those skill branches and helps you update.

Run `/update-skills` in Claude Code.

## How it works

**Preflight**: checks for clean working tree and upstream remote.

**Detection**: fetches upstream, lists all `upstream/skill/*` branches, uses merge-commit evidence to determine which ones are actually installed, and checks for new commits.

**Compatibility check**: flags skills that are incompatible with the current platform before offering them.

**Selection**: presents a list of skills with available updates. You pick which to update.

**Update**: merges each selected skill branch, resolves conflicts if any, then validates with build + test.

## Platform-incompatible skills

Some skills replace core runtime components and are mutually exclusive. NEVER merge these without explicit user confirmation and a clear understanding of what they change:

| Skill | Platform | What it replaces |
|-------|----------|-----------------|
| `skill/apple-container` | macOS only | Changes `CONTAINER_RUNTIME_BIN` from `docker` to `container`, rewrites `container-runtime.ts` entirely. **Will break Linux/Docker installs.** |
| `skill/native-credential-proxy` | Any | Replaces OneCLI gateway with built-in credential proxy. Changes `credential-proxy.ts` and container startup. |

If the current platform is Linux (`uname -s` returns `Linux`), **do NOT offer `skill/apple-container` as an update**. Skip it silently or list it as "incompatible with current platform".

---

# Goal
Help users update their installed skill branches from upstream without losing local customizations.

# Operating principles
- Never proceed with a dirty working tree.
- Only offer updates for skills that are **confirmed installed** via merge-commit evidence.
- Never merge platform-incompatible skills without explicit confirmation.
- Use git-native operations. Do not manually rewrite files except conflict markers.
- Keep token usage low: rely on `git` commands, only open files with actual conflicts.
- After merging, always verify the build passes BEFORE moving to the next skill.

# Step 0: Preflight

Run:
- `git status --porcelain`

If output is non-empty:
- Tell the user to commit or stash first, then stop.

Check remotes:
- `git remote -v`

If `upstream` is missing:
- Ask the user for the upstream repo URL (default: `https://github.com/qwibitai/nanoclaw.git`).
- `git remote add upstream <url>`

Fetch:
- `git fetch upstream --prune`

Detect platform:
- `uname -s` — store result (Linux or Darwin)

# Step 1: Detect installed skills with available updates

List all upstream skill branches:
- `git branch -r --list 'upstream/skill/*'`

For each `upstream/skill/<name>`, determine if it is **actually installed** using this two-step check:

**Step A — Merge-commit evidence (required):**
```bash
git log --oneline --merges --grep="skill/<name>" HEAD | head -5
```
If this returns NO merge commits referencing `skill/<name>`, the skill is **not installed**. Period. Do not fall back to merge-base heuristics — those produce false positives when upstream merges main into skill branches.

**Step B — File evidence (confirmation):**
Check that the skill's characteristic files exist in the working tree. Every feature skill adds at least a SKILL.md:
```bash
ls .claude/skills/<name>/SKILL.md 2>/dev/null || ls .claude/skills/add-<name>/SKILL.md 2>/dev/null
```
If merge commits exist but no files exist, the skill may have been uninstalled or the merge was reverted. Mark as "uncertain" and ask the user.

**Step C — New commits check:**
Only for confirmed-installed skills:
```bash
git log --oneline HEAD..upstream/skill/<name>
```
If this produces output, there are updates available.

**Step D — Platform compatibility filter:**
Before adding to the "updates available" list, check compatibility:
- If platform is Linux and skill is `apple-container`: skip, mark as "incompatible (macOS only)"
- If platform is Darwin and skill is `apple-container`: include normally

Build four lists:
- **Updates available**: installed AND have new commits AND compatible
- **Up to date**: installed and have no new commits
- **Not installed**: no merge-commit evidence
- **Incompatible**: has updates but wrong platform

# Step 2: Present results

If no skills have updates available:
- Tell the user all installed skills are up to date. List them.
- If there are uninstalled skills, mention them briefly.
- If there are incompatible skills with updates, mention them with the reason.
- Stop here.

If updates are available:
- Show the list of skills with updates, including the number of new commits and file-level diff stat:
  ```
  skill/<name>: 3 new commits (4 files, +200/-50)
  skill/<other>: 1 new commit (1 file, +20/-5)
  ```
  Get the diff stat with: `git diff HEAD...upstream/skill/<name> --stat | tail -1`
- Also show skills that are up to date (for context).
- Show incompatible skills separately with the reason they're excluded.
- Use AskUserQuestion with `multiSelect: true` to let the user pick which skills to update.
  - One option per skill with updates, labeled with the skill name and commit count.
  - Add an option: "Skip — don't update any skills now"
- If user selects Skip, stop here.

# Step 3: Pre-merge review

Before merging each skill, do a dry-run conflict check:
```bash
git merge --no-commit --no-ff upstream/skill/<name> 2>&1; \
echo "---CONFLICTS---"; \
git diff --name-only --diff-filter=U 2>/dev/null; \
echo "---END---"; \
git merge --abort 2>/dev/null
```

If the dry-run shows conflicts in **core runtime files** (`src/container-runtime.ts`, `src/container-runner.ts`, `src/index.ts`, `src/config.ts`):
- Warn the user: "This skill modifies core files: <list>. Conflicts detected in: <list>."
- Ask if they want to proceed, skip this skill, or abort all updates.

If clean or conflicts are only in non-core files: proceed.

# Step 4: Apply updates

For each selected skill (process one at a time):

1. Tell the user which skill is being updated.
2. Run: `git merge upstream/skill/<name> --no-edit`
3. If the merge is clean: run `npm run build` to verify. If build passes, move to next skill. If build fails, investigate immediately (don't batch).
4. If conflicts occur:
   - Run `git status` to identify conflicted files.
   - For each conflicted file:
     - Open the file.
     - Resolve only conflict markers.
     - **Preserve custom modifications** — when in doubt, keep custom side.
     - `git add <file>`
   - Complete the merge: `git commit --no-edit`
   - Run `npm run build` to verify before moving to next skill.

If a merge fails badly (e.g., cannot resolve conflicts):
- `git merge --abort`
- Tell the user this skill could not be auto-updated and they should resolve it manually.
- Continue with the remaining skills.

If a build fails after merge:
- Show the error.
- Only fix issues clearly caused by the merge (missing imports, type mismatches).
- Do not refactor unrelated code.
- Run `npm run build` again to confirm the fix.
- If unclear, ask the user.

# Step 5: Final validation

After all selected skills are merged and individually verified:
- `npx vitest run` — report results but do not fail the flow if some tests fail.
- If tests fail, check if failures are in files touched by the merges.

# Step 6: Summary

Show:
- Skills updated (list)
- Skills skipped or failed (if any)
- Skills excluded as incompatible (if any)
- New HEAD: `git rev-parse --short HEAD`
- Any conflicts that were resolved (list files)
- Build status: pass/fail
- Test status: X/Y passed

If the service is running, remind the user to restart it to pick up changes.
