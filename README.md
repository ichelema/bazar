# Bazar

If you use Claude Code across multiple projects, you're probably copying the same skills, agents, and settings between them. When you improve a skill in one project, the others fall behind. When you set up a new project, you manually reconstruct the `.claude/` folder from memory.

Bazar solves that. One repo holds everything. Each project picks what it needs. Changes flow both ways. The entire system is controlled through natural language via the `/bazar` command.

<p align="center"><a href="diagrams/variants.png"><img src="diagrams/variants.png" width="85%" alt="Bazar syncing to multiple projects" /></a></p>

## Getting Started

You need [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and the [GitHub CLI](https://cli.github.com/) (`gh auth login`).

### Option A: Start from this template (recommended)

1. Download the [`bazar.md`](commands/bazar.md) command file
2. Place it at `.claude/commands/bazar.md` in any project
3. Open Claude Code and say:

```
/bazar let's set up my own bazar
```

Claude will:

- Create your private repo from this template
- Install the auto-sync hook in your current project
- Import your existing `.claude/` content
- Connect everything

### Option B: Manual setup

```bash
# Create your private repo from this template
gh repo create my-bazar --template ichelema/bazar --private --clone

# In your project, init and sync
cd my-project
node ../my-bazar/sync.mjs --seed --name "CLAUDE--my-project"

# Register the bazar path on this device (one-time per machine)
node ../my-bazar/sync.mjs --link
```

After either option, everything is `/bazar` from here on.

## What It Manages

| Category        | What it is                            | Example                                         |
| --------------- | ------------------------------------- | ----------------------------------------------- |
| **Skills**      | Domain knowledge bases (folders)      | `react/`, `git-commits/`, `auth/`               |
| **Agents**      | Specialist sub-agent definitions      | `backend-engineer.md`, `frontend-specialist.md` |
| **Commands**    | Slash commands (`/build`, `/plan`)    | `build.md`, `team-plan.md`                      |
| **Hooks**       | Automation scripts                    | `FormatterHook/`, `SkillActivationHook/`        |
| **Rules**       | Auto-loaded context files             | `repo-primer.md` (per project)                  |
| **CLAUDE.md**   | Behavioral instructions               | One per project or profile                      |
| **Settings**    | Hook config, permissions, status line | `settings.json` per project                     |
| **MCP configs** | Model Context Protocol servers        | `.mcp.json` per project/platform                |
| **Files**       | Anything else                         | justfile, .gitignore, .editorconfig             |

## Using /bazar

Once set up, `/bazar` is your single interface. Just talk:

```
/bazar sync                                --> Pull latest from the bazar
/bazar what's out of sync?                 --> Show diff table
/bazar push my changes                     --> Push with confirmation
/bazar add the payment-processing skill    --> Add to this project
/bazar I built a new skill, add it         --> Create new bazar item
/bazar create a variant of react           --> Project-specific version
/bazar set up my-new-repo                  --> Connect another project
/bazar create a profile called minimal     --> Reusable item selection
/bazar add react to the dev profile        --> Update a profile
/bazar is auto-sync working?               --> Check BazarHook status
/bazar show everything                     --> Full inventory
```

## How Sync Works

**Sync** pulls from the bazar into your project. **Push** sends your local edits back.

```
Bazar ----sync----> Project     (bazar overwrites project)
Bazar <---push----- Project     (project overwrites bazar)
Bazar <---diff----> Project     (compare only, no changes)
```

```bash
node sync.mjs                              # sync current directory
node sync.mjs --push                       # push all changes
node sync.mjs --push -y                    # push without confirmation
node sync.mjs --diff                       # compare project vs bazar
node sync.mjs --all                        # sync every mapped project
node sync.mjs --list                       # show full inventory
node sync.mjs --add skills react           # add item to this project
node sync.mjs --remove skills archon       # remove item
node sync.mjs --init --profile dev         # init from a profile
node sync.mjs --seed --name "CLAUDE--app"  # import existing project
```

## Variants

The same skill can have different versions for different projects. Variants use a `name--suffix` convention in the bazar but deploy under the base name.

<p align="center"><a href="diagrams/hero-architecture.png"><img src="diagrams/hero-architecture.png" width="85%" alt="Variant resolution" /></a></p>

| In the bazar            | Deployed as             | Who gets it                        |
| ----------------------- | ----------------------- | ---------------------------------- |
| `skills/react/`         | `.claude/skills/react/` | Projects mapping `"react"`         |
| `skills/react--strict/` | `.claude/skills/react/` | Projects mapping `"react--strict"` |
| `CLAUDE--web-app.md`    | `CLAUDE.md`             | The web-app project                |

The variant suffix never appears in your project. Push sends changes back to the correct variant automatically.

## Profiles

Profiles are reusable item selections. Apply them when setting up new projects:

```bash
node sync.mjs --init --profile dev
node sync.mjs --add skills payment-processing   # stack more on top
node sync.mjs
```

Define profiles in `map.json`:

```json
{
  "profiles": {
    "dev": {
      "skills": ["react", "git-commits", "auth"],
      "agents": ["backend-engineer", "frontend-specialist"],
      "commands": ["build", "team-plan", "bazar"],
      "hooks": ["SkillActivationHook", "FormatterHook", "BazarHook"],
      "rules": ["repo-primer--dev"],
      "claude-md": "CLAUDE--dev",
      "settings": "settings--dev"
    }
  }
}
```

## Auto-Sync

The BazarHook keeps project and bazar aligned without manual pushes.

**Two drivers:**

- **Stop** (`bazar-sync.mjs`): runs at the end of every Claude turn. A cheap mtime scan over managed files detects local edits (by Claude, IDE, or terminal) and pushes them to the bazar synchronously.
- **SessionStart** (`bazar-session-start.mjs`): runs on startup/resume. Pushes any pending local edits first, then syncs bazar -> project. If the push is refused, the sync is skipped so local edits are never overwritten.

Both auto-pushes are additive: they never delete bazar files that are absent on this device.

Every sync keeps the two hook entries registered in the project's `settings.json`, even when that file is managed by the bazar. Disable/enable via `/bazar disable auto-sync` or `/bazar enable auto-sync` (which removes or adds the `BazarHook` item).

## Upgrading

A bazar created from this template does not share its git history, so engine fixes do not arrive by themselves. Run:

```bash
node sync.mjs --upgrade
```

It fetches the template named in `map.json` (`"template"`), shows which engine files changed (`sync.mjs`, `lib/`, `hooks/BazarHook/`, `commands/bazar.md`, `.claude/commands/bazar.md`, `.gitattributes`), and after confirmation commits and pushes them. Your skills, agents, `map.json`, settings and README are never touched.

## Repository Structure

```
your-bazar/
├── sync.mjs                  # CLI engine (pure Node.js, zero deps)
├── map.json                  # Project and profile definitions
├── lib/                      # Shared helper modules used by sync.mjs
├── skills/                   # Skill folders (SKILL.md + supporting files)
├── agents/                   # Agent definitions (.md files)
├── commands/                 # Slash commands (.md files)
│   └── bazar.md              # The /bazar command itself
├── hooks/                    # Hook systems (folders with .mjs files)
│   └── BazarHook/            # Auto-sync hook (included)
├── rules/                    # Rule files (.md, one per project variant)
├── claude-mds/               # CLAUDE.md files (one per project/profile)
├── settings/                 # settings.json files (one per project/profile)
├── mcp-configs/              # .mcp.json files (per project/platform)
├── files/                    # Arbitrary files with custom deploy paths
└── master-skill-rules.json   # Skill activation rules (filtered per project)
```

## Technical Details

- **Zero dependencies.** Pure Node.js (`fs`, `path`, `child_process`, `crypto`)
- **Cross-platform.** Windows, macOS, Linux
- **Git integration.** Sync pulls before operating. Push commits and pushes automatically
- **Hash-based diff.** MD5 comparison for files and directories
- **Ignore patterns.** Configure in `map.json` to exclude runtime artifacts from sync
- **Per-device bazar path** stored in `~/.claude/bazar-paths.json` (gitignored, never shipped). Run `node sync.mjs --link` once per machine to register. The `CLAUDE_BAZAR_PATH` environment variable overrides it.
- **Multi-machine projects.** Projects are keyed in `map.json` by folder name, and `.claude/bazar.json` records that key, so the same repo is recognized on Windows and Linux regardless of where it is cloned. `paths` lists, per device (hostname), where each project lives; each device prunes only its own list, and `--all` syncs only folders whose manifest names that project.
- **Stable manifest.** `.claude/bazar.json` (committed) holds only the project key, bazar remote and managed items, so it changes only when the item list changes. Per-device sync state goes to `.claude/bazar.state.json`, which every sync adds to the project's `.gitignore`.

## Credits

Derived from [claude-fast-library](https://github.com/Abdo-El-Mobayad/claude-fast-library) by Abdo El Mobayad, part of [Claude Fast](https://claudefa.st) -- an AI development management system for Claude Code.
