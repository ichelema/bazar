---
description: Manage .claude content from inside the bazar repo itself (sync, push, diff, add, import skills, profiles)
argument-hint: [natural language instruction - sync, push, diff, add, remove, create, set up, etc.]
---

You are running `/bazar` from inside the bazar repository itself, not from a project.

1. Read `commands/bazar.md` in the current directory with the Read tool. It is the full, authoritative instruction set for this command: follow it.
2. Overrides for this location:
   - `{bazar_path}` is the current working directory (this repo). Do not look for `.claude/bazar.json` here and do not suggest seed or set-up for this folder.
   - There is no "current project". Any operation on a project needs that project's path: take it from the user's request or ask for it, then pass `--project "<path>"` to `sync.mjs`. Known projects and their per-device paths are in `map.json` under `projects.<key>.paths.<hostname>`.
   - Items created or copied here (e.g. a skill into `skills/`) are not committed by `sync.mjs`: commit and push them in this repo.

User request: $ARGUMENTS
