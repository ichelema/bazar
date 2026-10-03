---
description: Manage .claude folder content from your private bazar
argument-hint:
  [
    natural language instruction - sync,
    push,
    diff,
    add,
    remove,
    create,
    set up,
    etc.,
  ]
---

# /bazar -- Bazar Manager

You are the single interface between the user and their Bazar system. The user speaks naturally. You figure out the operation, execute it, and report results.

## How the System Works

A central git repo (the bazar) holds all reusable `.claude/` content: skills, agents, commands, hooks, rules, CLAUDE.md files, settings, MCP configs, and arbitrary files. Each project is mapped in `map.json` to receive a specific selection of items. A manifest file in each project tracks what the bazar owns.

Projects are keyed in `map.json` by a device-independent name (the folder name by default, or `--init --name <key>`), and the manifest records that key in its `project` field. The same repo is therefore recognized on every machine, wherever it is cloned. If a different project with the same folder name already exists, `--init` mints a short suffix once (`api-7f3a`) and prints it. The manifest key is authoritative: if it is missing from `map.json`, sync/add/remove stop with an error instead of falling back to the folder name (re-run `--init` to register the project again under the same key).

Commands that edit `map.json` (`sync`, `--add`, `--remove`, `--init`, `--seed`) commit and push it immediately, so the bazar never keeps an uncommitted `map.json` that would block the next pull on another device. If a push fails (e.g. offline), the commit stays local, the command reports `Git error`, and the next run publishes it (pull falls back to a rebase when this device has local commits). Each project's `paths` array just lists where it has been seen; `--all` uses the ones that exist on the current device.

**Key concepts:**

- **Sync** (bazar to project): copies bazar items into the project's `.claude/` folder. Bazar wins.
- **Push** (project to bazar): sends local edits back. Project wins on shared files. **Additive by default: a push never deletes bazar files that are absent on this device** (this is what stops two devices with divergent `.claude/` trees from clobbering each other's content). Pass `--prune` (alias `--mirror`) only to make the bazar exactly mirror this device, propagating intentional deletions/renames. Creates a git commit in the bazar repo.
- **Diff**: compares hashes between project and bazar without changing anything.
- **Variants**: `name--suffix` convention. `react--strict` in the bazar deploys as `react` in the project. The manifest tracks the mapping so push sends changes back to the correct variant.
- **Profiles**: named item selections in map.json (e.g., `dev`, `ops`, `starter`). Applied with `--init --profile`.
- **Auto-sync**: the BazarHook has two drivers. The `Stop` driver (`bazar-sync.mjs`) runs at the end of every Claude turn: it does a cheap mtime walk over managed files and runs `sync.mjs --push --yes` synchronously when something is newer than the last sync. The `SessionStart` driver (`bazar-session-start.mjs`) runs on startup/resume: it pushes pending local edits first, then syncs bazar -> project (and skips the sync if the push is refused, so local edits are never overwritten). Both auto-pushes are **additive and never pass `--prune`**, so an automatic sync can never delete another device's content. No manual push needed for routine edits. No detached spawning, no platform-specific code.

### What gets synced

| Category  | Bazar storage             | Deployed to                  | Type      |
| --------- | ------------------------- | ---------------------------- | --------- |
| skills    | `skills/{name}/`          | `.claude/skills/{name}/`     | directory |
| agents    | `agents/{name}.md`        | `.claude/agents/{name}.md`   | file      |
| commands  | `commands/{name}.md`      | `.claude/commands/{name}.md` | file      |
| hooks     | `hooks/{name}/`           | `.claude/hooks/{name}/`      | directory |
| rules     | `rules/{name}.md`         | `.claude/rules/{name}.md`    | file      |
| claude-md | `claude-mds/{name}.md`    | `CLAUDE.md`                  | file      |
| settings  | `settings/{name}.json`    | `.claude/settings.json`      | file      |
| mcp       | `mcp-configs/{name}.json` | `.mcp.json`                  | file      |
| files     | `files/{name}`            | custom path from map.json    | file      |

Additionally, `master-skill-rules.json` is filtered per-project during sync to produce `skill-rules.json`. (Agent activation rules were retired in v5.7: the SkillActivationHook no longer recommends agents, so there is no `master-agent-rules.json` and no generated `agent-rules.json`.)

## Context Gathering

Before executing any operation:

1. Read `.claude/bazar.json` (committed) for: project key (`project`), bazar remote (`bazar_remote`), managed items. This device's sync state (last sync time `synced_at`, bazar commit `bazar_commit`, `base_hashes`) lives in `.claude/bazar.state.json`, which is gitignored and created by the first sync on each device
2. Resolve where the bazar repo lives on this device: `~/.claude/bazar-paths.json` maps `bazar_remote` to a local path (the `CLAUDE_BAZAR_PATH` environment variable overrides it). Store this as `{bazar_path}`
3. If the manifest is missing AND no bazar repo exists locally, the user may need initial setup. Check for the "First-Time Setup" triggers below.
4. If the manifest is missing but a bazar repo exists, suggest `/bazar seed` or `/bazar set me up`
5. For operations that need project/profile data, read `{bazar_path}/map.json`

## Intent Detection and Workflows

Parse `$ARGUMENTS` and match to the appropriate workflow below. The first section covers initial setup (one-time). Everything after covers ongoing usage.

---

## First-Time Setup

### Create My Own Bazar

**Triggers:** "set up my own bazar", "create my bazar", "I want my own bazar", "let's set up a bazar", "get started", "first time setup"

**Prerequisites check:**

1. Verify GitHub CLI is authenticated: `gh auth status`
2. If not authenticated, tell the user to run `gh auth login` first and come back

**Workflow:**

1. **Ask the user what to name their private bazar repo.** Suggest a default like `bazar`. The repo will be created as `{github-username}/{name}`.

2. **Create the private repo from the Bazar template:**

```bash
gh repo create {name} --template ichelema/bazar --private --clone
```

This gives them their own private copy with sync.mjs, empty category directories, and starter map.json.

3. **Note the local clone path.** The repo is cloned to `./{name}` in the current directory. Store this as `{bazar_path}` for the remaining steps.

4. **Install the BazarHook into the current project:**

   - Create `.claude/hooks/BazarHook/` directory
   - Copy the 3 hook files from `{bazar_path}/hooks/BazarHook/`:
     - `bazar-sync.mjs` (Stop-event driver; mtime scan + synchronous push)
     - `bazar-session-start.mjs` (SessionStart driver; push pending edits, then sync)
     - `bazar-path-resolver.mjs` (shared helper: resolves the local bazar path)
   - Update `.claude/settings.json` -- add a `Stop` entry and a `SessionStart` entry:

     ```json
     "Stop": [
       {
         "hooks": [
           {
             "type": "command",
             "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/BazarHook/bazar-sync.mjs\"",
             "timeout": 30
           }
         ]
       }
     ],
     "SessionStart": [
       {
         "matcher": "startup|resume",
         "hooks": [
           {
             "type": "command",
             "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/BazarHook/bazar-session-start.mjs\"",
             "timeout": 60
           }
         ]
       }
     ]
     ```

   - Add to `.claude/.gitignore` (create if needed): `hooks/BazarHook/pending-sync.json`

5. **Copy the /bazar command into the current project:**

   - Copy `{bazar_path}/commands/bazar.md` to `.claude/commands/bazar.md`

6. **Seed the current project into the bazar:**

```bash
node {bazar_path}/sync.mjs --seed --name "CLAUDE--{project-name}" --project "{cwd}"
```

This imports the user's existing `.claude/` content (skills, agents, commands, hooks, CLAUDE.md, settings) into the bazar and creates the project mapping.

7. **Register the bazar path on this device** (one-time per machine):

```bash
node {bazar_path}/sync.mjs --link
```

8. **Report what was imported** and tell the user:
   - "Your bazar is set up at `{bazar_path}` and connected to this project."
   - "Everything in your `.claude/` folder has been imported to the bazar."
   - "From now on, use `/bazar` for all bazar operations."
   - "To add another project: open it in Claude Code and say `/bazar set me up`"

### Connect Another Project to My Bazar

**Triggers:** "set me up", "connect to my bazar", "add this project to the bazar", "I have a bazar already"

This is for users who already have a bazar repo and want to connect a new project.

**Workflow:**

1. Ask where the bazar repo is cloned locally (or check `~/.claude/bazar-paths.json` and common paths)
2. Install the BazarHook (same as step 4 above)
3. Copy the /bazar command (same as step 5 above)
4. Init with a profile or seed:
   - If the user has existing `.claude/` content to import: seed
   - If starting fresh: `--init --profile` with their preferred profile
5. Sync

---

## Ongoing Usage

### Sync / Pull Latest

**Triggers:** "sync", "update", "pull", "refresh", "get latest"

```bash
node {bazar_path}/sync.mjs --project "{cwd}"
```

Report items synced and any warnings.

### Sync All Projects

**Triggers:** "sync all", "update everything", "sync everywhere"

```bash
node {bazar_path}/sync.mjs --all
```

Report per-project results.

---

### Push Changes Back

**Triggers:** "push", "save to bazar", "send back", "push my changes", "I modified X push it"

**Workflow:**

1. Run diff first to show what changed
2. Show the diff table to the user
3. Ask for confirmation
4. Push with appropriate scope:

```bash
# Specific item
node {bazar_path}/sync.mjs --push --category {cat} --item {name} --project "{cwd}"

# Entire category
node {bazar_path}/sync.mjs --push --category {cat} --project "{cwd}"

# Everything changed
node {bazar_path}/sync.mjs --push --project "{cwd}" --yes

# Destructive mirror: ALSO delete bazar files absent on this device
# (intentional deletes/renames ONLY; never for a routine push)
node {bazar_path}/sync.mjs --push --project "{cwd}" --prune --yes
```

**Additive by default (`--prune`/`--mirror` to delete):** a normal push only adds and updates files. It never removes a bazar file just because it is missing on this device, and it prints `preserved N bazar-only file(s)` when it keeps such files. This is what prevents two devices with divergent `.claude/` trees from clobbering each other. Pass `--prune` (alias `--mirror`) ONLY when the user explicitly wants the bazar to exactly match this device, i.e. a real deletion or rename should propagate. If a push warns that it preserved files the user actually meant to delete, re-run the same push with `--prune`. When in doubt, do NOT prune.

**Scope detection from natural language:**

- "push growth-kit" -> `--category skills --item growth-kit`
- "push all skills" -> `--category skills`
- "push everything" -> no filter
- "push the frontend agent" -> `--category agents --item frontend-specialist`
- "delete X from the bazar", "mirror my device", "prune the bazar", "propagate the deletion" -> add `--prune` (destructive; confirm first)

---

### Diff / Status

**Triggers:** "diff", "status", "what's different", "out of sync", "what changed"

```bash
node {bazar_path}/sync.mjs --diff --project "{cwd}"
```

Output key: `= in-sync`, `* changed`, `! missing`.

### Cross-Project Diff

**Triggers:** "what's different across projects", "compare all projects", "which projects are stale"

Read `map.json`, take each project's `paths` that exist on this device, then run diff on each:

```bash
node {bazar_path}/sync.mjs --diff --project "{path1}"
node {bazar_path}/sync.mjs --diff --project "{path2}"
# ... for each project
```

Summarize: which projects are fully in sync, which have changes, which have missing items.

---

### List / Show

**Triggers:** "list", "show", "what do I have", "show everything", "what's available", "what's in the bazar"

```bash
node {bazar_path}/sync.mjs --list
```

Shows all items, profiles, projects, and their configurations.

### Bazar Health Check

**Triggers:** "health", "which items aren't used", "stale projects", "unused items", "cleanup"

**Workflow:**

1. Read `map.json` to get all projects and all items
2. For each item in the bazar dirs, check if any project maps it
3. Report: items used by 0 projects (orphaned), projects with stale sync times, profiles that reference non-existent items

---

### Add Item to This Project

**Triggers:** "add [item]", "I need [item]", "include [item]", "give me [item]"

**Workflow:**

1. Determine the category. If not specified, scan bazar directories to find it
2. Run the add:

```bash
# Standard categories
node {bazar_path}/sync.mjs --add {category} {item} --project "{cwd}"

# Files (requires deploy path)
node {bazar_path}/sync.mjs --add files {bazar-name} {deploy-path} --project "{cwd}"
```

If the item doesn't exist in the bazar, ask: "That item doesn't exist in the bazar yet. Want me to create it from the local version?" Then follow the "Create New Bazar Item" workflow.

### Add Item to Multiple Projects

**Triggers:** "add [item] to all projects", "add [item] everywhere", "add [item] to all dev projects"

**Workflow:**

1. Read `map.json` to find target projects
2. If "all": iterate every project
3. If "all dev projects": iterate projects using the `dev` profile (match by comparing their config against the profile)
4. For each target project, using a path from its `paths` that exists on this device:

```bash
node {bazar_path}/sync.mjs --add {category} {item} --project "{path}"
```

5. Sync each project afterward

---

### Remove Item

**Triggers:** "remove [item]", "drop [item]", "don't need [item]", "uninstall [item]"

1. Confirm with user
2. Run:

```bash
node {bazar_path}/sync.mjs --remove {category} {item} --project "{cwd}"
```

---

### Create New Bazar Item

**Triggers:** "I built a new skill called X", "add this to the bazar", "put X in the bazar", "create a new [skill/agent/command]"

This is different from "add item to project." This creates a new item IN the bazar that doesn't exist yet.

**Workflow:**

1. Identify the item: is it a local file/folder the user just built, or something to create from scratch?
2. Copy it to the bazar:
   - **Directory items** (skills, hooks): `cp -r .claude/{category}/{name} {bazar_path}/{category}/{name}`
   - **File items** (agents, commands, rules): `cp .claude/{category}/{name}.md {bazar_path}/{category}/{name}.md`
3. Add it to the current project's mapping in `map.json` (read map, add to the project's array, write map)
4. If the user wants it in a profile too, add to the profile's array in `map.json`
5. If the item has keyword triggers, add entries to `{bazar_path}/master-skill-rules.json`
6. Run sync to update the manifest:

```bash
node {bazar_path}/sync.mjs --project "{cwd}"
```

7. Commit the bazar repo:

```bash
cd {bazar_path} && git add -A && git commit -m "add {category}/{name}" && git push
```

### Add Item to a Profile

**Triggers:** "add [item] to the dev profile", "include [item] in all new projects"

**Workflow:**

1. Read `map.json`
2. Add the item to the specified profile's category array
3. Write `map.json`
4. Commit:

```bash
cd {bazar_path} && git add map.json && git commit -m "add {item} to {profile} profile" && git push
```

Note: this only affects future projects initialized with this profile. Existing projects are unchanged unless you also add the item to them individually.

---

### Create Variant

**Triggers:** "create variant", "save as variant", "fork [item]", "customize [item] for this project", "make a project-specific version"

**Workflow:**

1. Identify the item and its current bazar name from the manifest
2. Determine variant name. Suggest `{name}--{project-slug}` if not provided
3. Copy in the bazar:
   - **Directory**: `cp -r {bazar_path}/{category}/{name} {bazar_path}/{category}/{name}--{variant}`
   - **File**: `cp {bazar_path}/{category}/{name}.md {bazar_path}/{category}/{name}--{variant}.md`
4. Update `map.json`: change the project's entry from `"{name}"` to `"{name}--{variant}"`
5. Sync to update manifest
6. Commit the bazar

---

### Set Up New Project

**Triggers:** "set up [project]", "init", "add this project", "onboard [repo]", "bootstrap [project]"

**Workflow:**

1. Determine if a profile was specified. Default to `dev` if the user says "set up" without specifying
2. If the project path is different from cwd, ask or use the provided path

```bash
# Init with profile
node {bazar_path}/sync.mjs --init --profile {profile} --project "{project_path}"

# Sync
node {bazar_path}/sync.mjs --project "{project_path}"
```

3. Remind the user: "The project has a template repo primer at `.claude/rules/repo-primer.md`. Customize it for this project, then run `/bazar create variant of repo-primer` to save it back."

### Set Up from Another Project

**Triggers:** "set up like [other project]", "copy [project]'s config", "same setup as [project]"

```bash
node {bazar_path}/sync.mjs --init --from "{source_path}" --project "{cwd}"
node {bazar_path}/sync.mjs --project "{cwd}"
```

---

### Import / Seed Existing Project

**Triggers:** "seed", "import this project", "import my .claude folder", "add everything here to the bazar"

**Workflow:**

1. Ask for a name slug if not provided (convention: `CLAUDE--{repo-name}`)
2. Run:

```bash
node {bazar_path}/sync.mjs --seed --name "{slug}" --project "{cwd}"
```

3. Report what was imported, including any variants or renamed config files the output mentions

Seed never overwrites an item other projects may use:

- Free name: imported under its own name.
- Same name, identical content: only mapped, nothing copied.
- Same name, different content: imported as the variant `{name}--{project-key}`, which deploys as `{name}` in this project only.
- Engine items (`hooks/BazarHook`, `commands/bazar`): never imported, the project is mapped to the bazar's version.
- `CLAUDE.md` / `settings.json` / `.mcp.json` whose `{slug}` file already exists with different content: imported as `{slug}-xxxx`.
- Re-seeding the same project updates its own variants and config files in place.

Seed does not commit the imported items (only `map.json`); commit the bazar afterwards.

---

### Create New Profile

**Triggers:** "create a profile", "new profile called X", "make a minimal profile", "save this project's setup as a profile"

**Workflow:**

1. Read `map.json`
2. Build the profile definition:
   - If "save this project's setup as a profile": read the current project's config from map.json and copy it
   - If from scratch: ask the user what to include, or use a minimal default
3. Add to `map.json` under `profiles.{name}`
4. Write `map.json` and commit

Profile structure:

```json
{
  "claude-md": "CLAUDE--{name}",
  "settings": "settings--{name}",
  "skills": [...],
  "agents": [...],
  "commands": [...],
  "hooks": [...],
  "rules": [...],
  "files": {},
  "gitignore-lines": []
}
```

### Edit Profile

**Triggers:** "add X to the dev profile", "remove Y from the ops profile", "update profile"

Read `map.json`, modify the profile's arrays, write back, commit.

---

### Ignore Patterns

**Triggers:** "ignore [folder] in [item]", "exclude [path] from sync", "don't sync [folder]"

**Workflow:**

1. Read `map.json`
2. Add to the top-level `"ignore"` object: `{ "{item-slug}": ["{pattern}", ...] }`
3. Write `map.json` and commit
4. Run sync to propagate the ignore pattern to project manifests

Ignore patterns match against path segments. `profiles` excludes `profiles/`, `profiles/subdir/`, etc.

---

### MCP Config Management

**Triggers:** "set up MCP", "update mcp config", "switch to mac MCP", "copy MCP from [project]"

MCP configs are stored as `mcp-configs/{name}.json` in the bazar. Platform variants use `mcp--win`, `mcp--mac`, etc.

**Workflow:**

1. To assign: update the project's `"mcp"` field in `map.json` to the desired variant name
2. To create a new variant: copy `.mcp.json` from the project to `{bazar_path}/mcp-configs/{name}.json`
3. Sync to deploy

**Note:** MCP configs often contain API keys. Warn the user about credential handling. Template variants should use `<your-api-key>` placeholders.

---

### Auto-Sync Status

**Triggers:** "is auto-sync working", "check bazar hook", "sync status", "pending sync"

**Workflow:**

1. Check if BazarHook is registered in `.claude/settings.json` (a `Stop` entry pointing at `bazar-sync.mjs` and a `SessionStart` entry pointing at `bazar-session-start.mjs`)
2. Read `.claude/hooks/BazarHook/pending-sync.json`: schema is `{ "lastSyncAt": <ms>, "lastError": null|string }`. A non-null `lastError` means the most recent push attempt failed
3. Read `.claude/hooks/BazarHook/logs/bazar-sync.log` for recent push history
4. Report: hook status (enabled/disabled), last sync time, last error if any

### Disable/Enable Auto-Sync

**Triggers:** "disable auto-sync", "turn off bazar hook", "enable auto-sync", "turn on bazar hook"

Every sync of a project that maps `BazarHook` re-adds missing `Stop`/`SessionStart` entries to `.claude/settings.json`, so deleting them by hand does not last.

- To disable: `node {bazar_path}/sync.mjs --remove hooks BazarHook --project "{cwd}"`, then remove the `Stop` entry pointing at `bazar-sync.mjs` and the `SessionStart` entry pointing at `bazar-session-start.mjs` (and from the bazar's copy too, if `settings.json` is bazar-managed)
- To enable: `node {bazar_path}/sync.mjs --add hooks BazarHook --project "{cwd}"`; the sync registers the entries automatically

---

### Troubleshooting

**Triggers:** "sync isn't working", "push failed", "manifest missing", "bazar error"

**Diagnostic steps:**

1. Check manifest exists: `.claude/bazar.json` (and this device's state `.claude/bazar.state.json`; if missing, a plain sync recreates it)
2. Verify the bazar path resolves: `~/.claude/bazar-paths.json` must contain an entry for the manifest's `bazar_remote` (or `CLAUDE_BAZAR_PATH` must be set). If not, run `node sync.mjs --link` from the bazar directory
3. Check bazar repo status: `cd {bazar_path} && git status`
4. Check for lock files or pending operations
5. Check BazarHook logs: `.claude/hooks/BazarHook/logs/bazar-sync.log`
6. Try a manual diff to verify connectivity: `node {bazar_path}/sync.mjs --diff --project "{cwd}"`

If manifest is missing entirely, suggest: `/bazar seed` (to import existing project) or `/bazar set me up` (fresh init).

---

## Rules

1. **Confirm before destructive operations**: `push --prune`/`--mirror` (deletes bazar files absent on this device), remove, variant creation that overwrites. A plain push is additive (adds/updates only, never deletes) and is safe to run without prune.
2. **Show tables for diff/list output**: format cleanly with alignment
3. **Always use full absolute paths** when calling sync.mjs to avoid cwd issues
4. **Default bazar path**: resolve via `~/.claude/bazar-paths.json` keyed by `bazar_remote` from the project manifest. If unresolved, prompt the user to run `node sync.mjs --link` from their bazar directory.
5. **Every project should have its own repo-primer variant**: never share another project's primer. Use the template profile for new projects until a project-specific primer is created
6. **When editing map.json directly**: always read it fresh, modify, write back. Never assume cached state. Commit and push the bazar repo after map.json changes
7. **Category detection**: if the user names an item without a category, scan bazar directories (`skills/`, `agents/`, `commands/`, `hooks/`, `rules/`) to find it. Check both base names and variant names
8. **Variant naming**: suggest `{name}--{project-slug}` convention. The suffix should identify the project or purpose
9. **After any map.json edit**: run sync on affected projects to update manifests
10. **Report clearly**: after every operation, state what happened, what changed, and any follow-up actions needed
