#!/usr/bin/env node
/**
 * LibraryHook - SessionStart driver
 *
 * At session start: first pushes any local edits still pending (e.g. a
 * previous auto-push that failed), then syncs library -> project.
 *
 * Safety: if the push is refused, fails, or reports CONFLICT / NO BASE,
 * the sync is SKIPPED, so local edits are never overwritten.
 *
 * Output is JSON for Claude Code: reloadSkills makes freshly synced skills
 * visible in this session; additionalContext tells Claude what happened.
 *
 * NEVER blocks the session: always exits 0.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import {
  resolveLibraryPath,
  formatResolutionError,
} from "./library-path-resolver.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(__dirname, "..", "..", "..");
const stateFile = join(__dirname, "pending-sync.json");
// Push + sync run back to back: 2 x 25s stays under the 60s hook timeout.
const RUN_TIMEOUT_MS = 25_000;

function log(message) {
  try {
    const logDir = join(__dirname, "logs");
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, "library-sync.log");
    const prev = existsSync(logFile) ? readFileSync(logFile, "utf-8") : "";
    const line = `[${new Date().toISOString()}] [session-start] ${message}\n`;
    writeFileSync(logFile, prev + line);
  } catch {
    /* best-effort */
  }
}

function writeState(lastSyncAt, lastError) {
  try {
    writeFileSync(stateFile, JSON.stringify({ lastSyncAt, lastError }), "utf-8");
  } catch {
    /* non-fatal */
  }
}

function readLastSyncAt() {
  try {
    const s = JSON.parse(readFileSync(stateFile, "utf-8"));
    return typeof s.lastSyncAt === "number" ? s.lastSyncAt : Date.now();
  } catch {
    return Date.now();
  }
}

function emit(message, reloadSkills) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `[claude-library] ${message}`,
    },
  };
  if (reloadSkills) out.hookSpecificOutput.reloadSkills = true;
  process.stdout.write(JSON.stringify(out));
}

function run(syncScript, args) {
  const r = spawnSync(
    process.execPath,
    [syncScript, ...args, "--project", projectDir],
    { encoding: "utf-8", timeout: RUN_TIMEOUT_MS, cwd: projectDir, shell: false }
  );
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  return { ok: !r.error && r.status === 0, out };
}

async function main() {
  try {
    readFileSync(0, "utf-8");
  } catch {
    /* no stdin is fine */
  }

  let manifestPath = join(projectDir, ".claude", "library.json");
  if (!existsSync(manifestPath)) {
    manifestPath = join(projectDir, ".claude", ".library-manifest.json");
  }
  if (!existsSync(manifestPath)) return;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (e) {
    log("Manifest unreadable: " + e.message);
    return;
  }

  let libraryPath = null;
  try {
    const resolved = await resolveLibraryPath({
      libraryRemote: manifest.library_remote,
      manifestPath,
      projectDir,
    });
    libraryPath = resolved && resolved.path;
  } catch (e) {
    log("Path resolution threw: " + e.message);
  }
  if (!libraryPath) {
    const msg = formatResolutionError(manifest.library_remote);
    log(msg);
    emit("Sync all'avvio saltato: " + msg, false);
    return;
  }

  const syncScript = join(libraryPath, "sync.mjs");
  if (!existsSync(syncScript)) {
    log("sync.mjs not found at: " + syncScript);
    emit("Sync all'avvio saltato: sync.mjs non trovato in " + libraryPath, false);
    return;
  }

  // 1. Push pending local edits first (additive, never prunes).
  const push = run(syncScript, ["--push", "--yes"]);
  const blocked =
    !push.ok || /CONFLICT|NO BASE|REFUSED|ERROR|Git error/.test(push.out);
  if (blocked) {
    const detail = push.out.trim().split("\n").slice(-4).join(" | ");
    log("Push blocked, sync skipped: " + detail);
    writeState(readLastSyncAt(), "session-start: " + detail);
    emit(
      "Sync all'avvio SALTATO per non sovrascrivere modifiche locali. " +
        "Dettaglio: " + detail + ". Suggerisci all'utente di eseguire /library diff.",
      false
    );
    return;
  }

  // 2. Sync library -> project.
  const sync = run(syncScript, []);
  if (!sync.ok) {
    const detail = sync.out.trim().split("\n").slice(-3).join(" | ");
    log("Sync failed: " + detail);
    writeState(readLastSyncAt(), "session-start sync: " + detail);
    emit("Sync all'avvio fallito: " + detail, false);
    return;
  }

  // Files just copied have fresh mtimes: move lastSyncAt forward so the
  // Stop hook does not treat them as local edits.
  writeState(Date.now(), null);
  const pushedLine = /Pushed (\d+) item/.exec(push.out);
  const syncedLine = /Synced (\d+) items/.exec(sync.out);
  const msg =
    "Progetto allineato alla library" +
    (pushedLine ? `, ${pushedLine[1]} modifiche locali inviate prima del sync` : "") +
    (syncedLine ? ` (${syncedLine[1]} elementi sincronizzati).` : ".");
  log(msg);
  emit(msg, true);
}

(async () => {
  try {
    await main();
  } catch (e) {
    log("Unexpected error: " + (e && e.message ? e.message : String(e)));
  } finally {
    process.exit(0);
  }
})();
