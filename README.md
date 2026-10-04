# Bazar

English | [Italiano](README_ITA.md)

If you use Claude Code across multiple projects, you're probably copying the same skills, agents, and settings between them. When you improve a skill in one project, the others fall behind. When you set up a new project, you manually reconstruct the `.claude/` folder from memory.

Bazar solves that. One repo holds everything. Each project picks what it needs. Changes flow both ways. The entire system is controlled through natural language via the `/bazar` command.

<p align="center"><a href="diagrams/variants.png"><img src="diagrams/variants.png" width="85%" alt="Bazar syncing to multiple projects" /></a></p>

This repository is the **template**: it contains the engine (`sync.mjs`, the `BazarHook` auto-sync hook, the `/bazar` command) and empty category folders. Your own bazar is a private repo created from it, which holds your content and receives engine updates with `--upgrade`.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- [Git](https://git-scm.com/)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [GitHub CLI](https://cli.github.com/), logged in with `gh auth login` (only to create your bazar repo)

Works on Windows, macOS and Linux.

## Getting Started

### Option A: Let Claude set it up (recommended)

1. Download the [`bazar.md`](commands/bazar.md) command file
2. Place it at `.claude/commands/bazar.md` in any project
3. Open Claude Code in that project and say:

```
/bazar let's set up my own bazar
```

Claude will create your private repo from this template, import your existing `.claude/` content, install the auto-sync hook, and connect everything.

### Option B: Manual setup

```bash
# 1. Create your private bazar from this template
gh repo create my-bazar --template ichelema/bazar --private --clone

# 2a. A new project, starting from the "starter" profile (/bazar + auto-sync hook)
node my-bazar/sync.mjs --init --profile starter --project ./my-project

# 2b. OR an existing project whose .claude/ content you want to import
node my-bazar/sync.mjs --seed --name "CLAUDE--my-project" --project ./my-project
node my-bazar/sync.mjs --add commands bazar --project ./my-project
node my-bazar/sync.mjs --add hooks BazarHook --project ./my-project
cd my-bazar && git add -A && git commit -m "seed my-project" && git push && cd ..
```

Then commit the project's `.claude/` folder and `.gitignore` in the project's own repo. From here on, use `/bazar` inside the project.

The bazar registers its local path on each machine automatically the first time you run any `sync.mjs` command (`node sync.mjs --link` does it explicitly).

## Using /bazar

Once set up, `/bazar` is your single interface. Just talk:

```
/bazar sync                                --> Pull latest from the bazar
/bazar what's out of sync?                 --> Show diff table
/bazar push my changes                     --> Push with confirmation
/bazar add the payment-processing skill    --> Add to this project
/bazar remove the archon skill             --> Remove from this project only
/bazar I built a new skill, add it         --> Create new bazar item
/bazar create a variant of react           --> Project-specific version
/bazar set up my-new-repo                  --> Connect another project
/bazar create a profile called minimal     --> Reusable item selection
/bazar add react to the dev profile        --> Update a profile
/bazar add CLAUDE_GPT.md to every project  --> Add to "defaults" (all projects)
/bazar is auto-sync working?               --> Check BazarHook status
/bazar upgrade                             --> Update the engine from the template
/bazar show everything                     --> Full inventory
```

`/bazar` also works when Claude Code is opened inside the bazar repo itself (via `.claude/commands/bazar.md`, which loads `commands/bazar.md`). There, name the project you want to act on, e.g. `/bazar import the skill X from D:/AI/my-project`.

## What It Manages

Each category is stored in its own folder of the bazar and deployed to a fixed place in the project. Skills and hooks are **whole folders** (all files and subfolders); agents, commands and rules are **single `.md` files**.

| Category        | In the bazar              | Deployed to                  | Unit   |
| --------------- | ------------------------- | ---------------------------- | ------ |
| **Skills**      | `skills/{name}/`          | `.claude/skills/{name}/`     | folder |
| **Hooks**       | `hooks/{name}/`           | `.claude/hooks/{name}/`      | folder |
| **Agents**      | `agents/{name}.md`        | `.claude/agents/{name}.md`   | file   |
| **Commands**    | `commands/{name}.md`      | `.claude/commands/{name}.md` | file   |
| **Rules**       | `rules/{name}.md`         | `.claude/rules/{name}.md`    | file   |
| **CLAUDE.md**   | `claude-mds/{name}.md`    | `CLAUDE.md`                  | file   |
| **Settings**    | `settings/{name}.json`    | `.claude/settings.json`      | file   |
| **MCP configs** | `mcp-configs/{name}.json` | `.mcp.json`                  | file   |
| **Files**       | `files/{name}`            | any path you choose          | file   |

A skill like `git-commits` is synced as a whole, including e.g. `references/test.md`; you cannot track a single file inside it. To exclude parts of a folder item, use `ignore` in `map.json` (see below). `logs/`, `node_modules/`, `*.log`, `.DS_Store`, `Thumbs.db` and hook state files are always excluded.

**Files** are any other single file, placed where you say. Example: put `test.txt` at the root of a project.

```bash
cp test.txt my-bazar/files/test.txt
cd my-bazar && git add files/test.txt && git commit -m "add files/test.txt" && git push
node sync.mjs --add files test.txt test.txt --project ../my-project   # bazar name, then path in the project
```

## How Sync Works

**Sync** pulls from the bazar into your project. **Push** sends your local edits back.

```
Bazar ----sync----> Project     (bazar overwrites project)
Bazar <---push----- Project     (project overwrites bazar)
Bazar <---diff----> Project     (compare only, no changes)
```

- **Push is additive.** It adds and updates files but never deletes a bazar file just because it is missing on this device. Use `--push --prune` only to make the bazar mirror this device (intentional deletes or renames).
- **Conflicts are detected, not overwritten.** Each device remembers the state agreed at its last sync. A push reports and skips:
  - `CONFLICT`: both the bazar and this project changed the item. Sync to take the bazar version, or push that item with `--force` to keep yours.
  - `STALE`: the bazar moved on and nothing changed here. A plain sync updates the project.
  - `NO BASE`: the item exists in the bazar but this device never synced it. Sync first.
- **Line endings do not count as changes.** A file re-saved with CRLF instead of LF is still in sync.
- **Git is automatic.** Sync, diff and push pull the bazar first. Push commits and pushes. Commands that edit `map.json` (`sync`, `--add`, `--remove`, `--init`, `--seed`) commit and push it right away. If a push fails (e.g. offline), the commit stays local, the command reports `Git error`, and the next run publishes it.

## Command Reference

Run from anywhere; `--project <path>` selects the project (default: current directory).

| Command | What it does |
| --- | --- |
| `node sync.mjs` | Sync bazar -> project |
| `node sync.mjs --all` | Sync every project present on this machine |
| `node sync.mjs --diff` | Compare project and bazar (`=` in sync, `*` changed, `!` missing) |
| `node sync.mjs --push [-y]` | Push changed items (asks for confirmation unless `-y`) |
| `node sync.mjs --push --category skills --item react` | Push a single item (or a whole category without `--item`) |
| `node sync.mjs --push --prune` | Push and delete bazar files absent on this device |
| `node sync.mjs --push --category <cat> --item <name> --force` | Overwrite the bazar with this device's version (conflict resolution) |
| `node sync.mjs --add <cat> <name>` | Add an item to the project (`skills`, `agents`, `commands`, `hooks`, `rules`) |
| `node sync.mjs --add files <name> <path>` | Add a file from `files/` at `<path>` in the project |
| `node sync.mjs --remove <cat> <name>` | Remove an item from the project (it stays in the bazar) |
| `node sync.mjs --init --profile <name> [--name <key>]` | Register a new project from a profile |
| `node sync.mjs --init --from <project> [--name <key>]` | Register a new project copying another project's selection |
| `node sync.mjs --seed [--name <slug>]` | Import an existing project's `.claude/` content |
| `node sync.mjs --list` | Show items, profiles and projects |
| `node sync.mjs --upgrade [-y]` | Update the engine files from the template |
| `node sync.mjs --link` / `--unlink` | Register / unregister this bazar's path on this machine |

## Seeding an Existing Project

`--seed` imports a project's skills, agents, commands and hooks, and with `--name <slug>` also its `CLAUDE.md`, `settings.json` and `.mcp.json`. It never overwrites an item other projects may use:

- **Free name**: imported under its own name.
- **Same name, identical content**: only mapped, nothing copied.
- **Same name, different content**: imported as the variant `{name}--{project-key}`, which deploys as `{name}` in this project only.
- **Engine items** (`BazarHook`, `/bazar`): never imported; the project gets the bazar's version.
- **Config file whose name is taken by another project**: imported as `{slug}-xxxx`.

Seed commits only `map.json`: commit the imported items in the bazar yourself. `rules/` files are not imported.

## Removing Items

- **From one project only**: `node sync.mjs --remove skills react --project <path>`. The item is deleted from the project and its `map.json` entry; it stays in the bazar.
- **From the bazar and every project**: remove the name from every project and profile in `map.json`, delete the folder or file (and its `--variant` copies) from the bazar, remove its entry from `master-skill-rules.json` if any, then commit and push. Each project deletes its copy on its next sync.

Do not delete a managed item by hand inside a project: the next sync puts it back.

## Variants

The same item can have different versions for different projects. Variants use a `name--suffix` convention in the bazar but deploy under the base name.

<p align="center"><a href="diagrams/hero-architecture.png"><img src="diagrams/hero-architecture.png" width="85%" alt="Variant resolution" /></a></p>

| In the bazar            | Deployed as             | Who gets it                        |
| ----------------------- | ----------------------- | ---------------------------------- |
| `skills/react/`         | `.claude/skills/react/` | Projects mapping `"react"`         |
| `skills/react--strict/` | `.claude/skills/react/` | Projects mapping `"react--strict"` |
| `CLAUDE--web-app.md`    | `CLAUDE.md`             | The web-app project                |

The variant suffix never appears in your project, and push sends changes back to the correct variant. A project uses one variant per item: `--add skills react--strict` on a project that maps `react` switches it to `react--strict`.

## Profiles and map.json

`map.json` describes what every project gets. Profiles are reusable selections applied with `--init --profile`: they are copied once, so later profile edits do not reach existing projects. `defaults` is applied to **every** project at each sync.

```json
{
  "template": "https://github.com/ichelema/bazar.git",
  "ignore": {
    "BazarHook": ["logs", "pending-sync.json"],
    "git-commits": ["references"]
  },
  "defaults": {
    "files": { "CLAUDE_GPT.md": "CLAUDE_GPT.md" }
  },
  "profiles": {
    "dev": {
      "skills": ["react", "git-commits", "auth"],
      "agents": ["backend-engineer"],
      "commands": ["bazar", "build"],
      "hooks": ["BazarHook", "FormatterHook"],
      "rules": ["repo-primer--dev"],
      "claude-md": "CLAUDE--dev",
      "settings": "settings--dev",
      "mcp": "mcp--win",
      "files": { "justfile": "justfile" },
      "gitignore-lines": [".claude/hooks/BazarHook/pending-sync.json"]
    }
  },
  "projects": {
    "my-project": {
      "skills": ["react"],
      "commands": ["bazar"],
      "hooks": ["BazarHook"],
      "paths": { "MY-PC": ["D:/AI/my-project"], "my-laptop": ["/home/me/my-project"] }
    }
  }
}
```

- `template`: where `--upgrade` fetches the engine from.
- `ignore`: per item, path segments excluded from sync, diff and push.
- `defaults`: same shape as a project, merged into every project at each sync (the project entry wins on the same item, file or setting). To remove a default item, remove it from `defaults`: it leaves every project.
- `gitignore-lines`: lines added to the project's `.gitignore` on sync.
- `projects.<key>.paths`: maintained automatically, per machine.

## Auto-Sync

The `BazarHook` keeps project and bazar aligned without manual pushes.

- **Stop** (`bazar-sync.mjs`): runs at the end of every Claude turn. A cheap scan of modification times over managed files detects local edits (by Claude, an editor or the terminal) and pushes them.
- **SessionStart** (`bazar-session-start.mjs`): runs on startup/resume. Pushes pending local edits first, then syncs bazar -> project. If the push is refused, the sync is skipped so local edits are never overwritten.

Both auto-pushes are additive. Every sync keeps the two hook entries registered in the project's `settings.json`, even when that file is managed by the bazar. Logs are in `.claude/hooks/BazarHook/logs/bazar-sync.log`.

To turn auto-sync off, remove the hook item (`/bazar disable auto-sync`, or `--remove hooks BazarHook` plus deleting its `Stop`/`SessionStart` entries from `settings.json`).

## Multiple Machines

- **Projects are recognized by key, not by path.** The key is the folder name by default (or `--init --name <key>`); if another project already uses it, a short suffix is added once (`api-7f3a`). The key is stored in the project's `.claude/bazar.json`, so the same repo cloned anywhere, on Windows or Linux, maps to the same entry. If that key is missing from `map.json`, sync stops with an error instead of guessing.
- **The bazar path is per machine**, stored in `~/.claude/bazar-paths.json`. The `CLAUDE_BAZAR_PATH` environment variable overrides it.
- **`--all` is per machine.** It syncs only this machine's paths whose manifest names the project, and drops stale paths.

## What to Commit in Your Projects

Commit `.claude/` (including `.claude/bazar.json`) and `.gitignore`. Sync keeps these out of git automatically:

- `.claude/bazar.state.json`: this machine's sync state
- `.claude/hooks/BazarHook/logs/` and `pending-sync.json`: hook runtime files

`.claude/bazar.json` holds only the project key, the bazar remote and the managed items, so it changes only when the item list changes.

## Upgrading

A bazar created from this template does not share its git history, so engine fixes do not arrive by themselves. Run:

```bash
node sync.mjs --upgrade
```

It fetches the template named in `map.json` (`"template"`), shows which engine files changed (`sync.mjs`, `lib/`, `hooks/BazarHook/`, `commands/bazar.md`, `.claude/commands/bazar.md`, `.gitattributes`), and after confirmation commits and pushes them. Your skills, agents, `map.json`, settings and README are never touched. Projects receive the new hook and command on their next sync.

## Repository Structure

```
your-bazar/
├── sync.mjs                  # CLI engine (pure Node.js, zero dependencies)
├── map.json                  # Template URL, ignore patterns, profiles, projects
├── lib/                      # Helper modules used by sync.mjs
├── skills/                   # Skill folders (SKILL.md + supporting files)
├── agents/                   # Agent definitions (.md files)
├── commands/                 # Slash commands (.md files)
│   └── bazar.md              # The /bazar command (deployed to projects)
├── hooks/                    # Hook folders
│   └── BazarHook/            # Auto-sync hook
├── rules/                    # Rule files (.md)
├── claude-mds/               # CLAUDE.md files (one per project/profile)
├── settings/                 # settings.json files (one per project/profile)
├── mcp-configs/              # .mcp.json files (per project/platform)
├── files/                    # Single files with custom deploy paths
├── master-skill-rules.json   # Skill activation rules (filtered per project)
├── .claude/commands/bazar.md # Makes /bazar available inside the bazar repo itself
└── .gitattributes            # Stores text files with LF in the repo
```

## Credits

Derived from [claude-fast-library](https://github.com/Abdo-El-Mobayad/claude-fast-library) by Abdo El Mobayad, part of [Claude Fast](https://claudefa.st) -- an AI development management system for Claude Code.
