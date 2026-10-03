#!/usr/bin/env node

/**
 * sync.mjs - Bazar Sync Tool
 * Manages .claude folder content across multiple projects from a central bazar.
 * Pure Node.js, no external dependencies.
 */

import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  cpSync, rmSync, readdirSync, statSync, unlinkSync
} from 'node:fs';
import { join, basename, dirname, resolve, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { writePathRegistry, removePathRegistryEntry, readPathRegistry } from './lib/bazar-path-resolver.mjs';

// ── Constants ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BAZAR = __dirname;

const CATEGORIES = ['skills', 'agents', 'commands', 'hooks', 'rules'];
const DIR_CATEGORIES = ['skills', 'hooks'];
const FILE_CATEGORIES = ['agents', 'commands', 'rules'];

// ── Utilities ────────────────────────────────────────────────────────────────

function norm(p) { return p.replace(/\\/g, '/'); }

function readJSON(filepath) {
  return JSON.parse(readFileSync(filepath, 'utf8'));
}

function writeJSON(filepath, data) {
  writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n');
}

function parseItemName(name) {
  const idx = name.indexOf('--');
  if (idx === -1) return { deploy: name, full: name, variant: null };
  return { deploy: name.slice(0, idx), full: name, variant: name.slice(idx + 2) };
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function copyDir(src, dest) {
  ensureDir(dest);
  cpSync(src, dest, { recursive: true, force: true });
}

function copyFile(src, dest) {
  ensureDir(dirname(dest));
  cpSync(src, dest, { force: true });
}

function deleteItem(itemPath) {
  if (!existsSync(itemPath)) return;
  const stat = statSync(itemPath);
  if (stat.isDirectory()) rmSync(itemPath, { recursive: true, force: true });
  else unlinkSync(itemPath);
}

// ── Hashing ──────────────────────────────────────────────────────────────────

const IGNORE = ['logs', 'node_modules', '.DS_Store', 'Thumbs.db'];
const IGNORE_EXT = ['.log'];
const IGNORE_FILES = ['recommendation-log.json', 'skill-rules.json', 'agent-rules.json', '.syncignore', 'pending-sync.json', 'pushback-state.json'];

function shouldIgnore(name) {
  if (IGNORE.includes(name)) return true;
  if (IGNORE_FILES.includes(name)) return true;
  return IGNORE_EXT.some(ext => name.endsWith(ext));
}

// ── Ignore Patterns ─────────────────────────────────────────────────────────
// Source of truth: map.json "ignore" key. Propagated to manifest on sync.

function getIgnorePatterns(itemSlug, ignoreMap) {
  if (!ignoreMap) return [];
  const { deploy } = parseItemName(itemSlug);
  return ignoreMap[itemSlug] || ignoreMap[deploy] || [];
}

function shouldSyncIgnore(relativePath, patterns) {
  if (!patterns.length) return false;
  for (const pattern of patterns) {
    const p = pattern.replace(/\/$/, '');
    if (relativePath === p || relativePath.startsWith(p + '/')) return true;
    if (relativePath.split('/').includes(p)) return true;
  }
  return false;
}

function getAllFiles(dir, rootDir = null, syncIgnorePatterns = []) {
  if (!existsSync(dir)) return [];
  if (rootDir === null) rootDir = dir;
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (shouldIgnore(entry.name)) continue;
    const full = join(dir, entry.name);
    const rel = norm(relative(rootDir, full));
    if (shouldSyncIgnore(rel, syncIgnorePatterns)) continue;
    if (entry.isDirectory()) results.push(...getAllFiles(full, rootDir, syncIgnorePatterns));
    else results.push(full);
  }
  return results;
}

function hashPath(itemPath, ignorePatterns = []) {
  if (!existsSync(itemPath)) return null;
  const stat = statSync(itemPath);
  if (stat.isFile()) {
    return createHash('md5').update(readFileSync(itemPath)).digest('hex');
  }
  const hash = createHash('md5');
  const files = getAllFiles(itemPath, null, ignorePatterns).map(f => norm(relative(itemPath, f))).sort();
  for (const f of files) {
    hash.update(f);
    hash.update(readFileSync(join(itemPath, ...f.split('/'))));
  }
  return hash.digest('hex');
}

// ── Path Resolution ──────────────────────────────────────────────────────────

function bazarItemPath(category, fullName) {
  if (DIR_CATEGORIES.includes(category)) return join(BAZAR, category, fullName);
  return join(BAZAR, category, fullName + '.md');
}

function projItemPath(projectRoot, category, deployName) {
  if (DIR_CATEGORIES.includes(category)) return join(projectRoot, '.claude', category, deployName);
  return join(projectRoot, '.claude', category, deployName + '.md');
}

const MANIFEST_FILENAME = 'bazar.json';

function manifestPath(projectRoot) {
  return join(projectRoot, '.claude', MANIFEST_FILENAME);
}

// ── Git Operations ───────────────────────────────────────────────────────────

function gitPull() {
  try {
    execSync('git pull --ff-only', { cwd: BAZAR, stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function gitCommitAndPush(message) {
  try {
    execSync('git add -A', { cwd: BAZAR, stdio: 'pipe' });
    const status = execSync('git status --porcelain', { cwd: BAZAR, encoding: 'utf8' });
    if (!status.trim()) { console.log('  No changes to commit'); return false; }
    execSync(`git commit -m "${message}"`, { cwd: BAZAR, stdio: 'pipe' });
    try { execSync('git push', { cwd: BAZAR, stdio: 'pipe' }); } catch { /* no remote yet */ }
    return true;
  } catch (e) {
    console.error('  Git error:', e.message);
    return false;
  }
}

function getBazarCommit() {
  try { return execSync('git rev-parse --short HEAD', { cwd: BAZAR, encoding: 'utf8' }).trim(); }
  catch { return 'none'; }
}

function isBazarCommitAncestor(commit) {
  if (!/^[0-9a-f]{7,40}$/i.test(commit || '')) return null;
  try {
    execSync(`git merge-base --is-ancestor ${commit} HEAD`, { cwd: BAZAR, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getBazarRemote() {
  try { return execSync('git remote get-url origin', { cwd: BAZAR, encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

// ── Map Operations ───────────────────────────────────────────────────────────

function readMap() { return readJSON(join(BAZAR, 'map.json')); }
function writeMap(map) { writeJSON(join(BAZAR, 'map.json'), map); }

// Projects are keyed in map.json by a device-independent name (the folder
// name by default). The project's manifest records that key, so the same
// repo is recognized on every machine regardless of where it is cloned.
// `config.paths` only lists where the project has been seen, for --all.
function projectKey(projectRoot) {
  return basename(resolve(projectRoot));
}

function findProject(map, targetPath) {
  let key = null;
  const mPath = manifestPath(targetPath);
  if (existsSync(mPath)) {
    try { key = readJSON(mPath).project || null; } catch {}
  }
  if (!key || !(key in map.projects)) key = projectKey(targetPath);
  const config = map.projects[key];
  return config ? { key, config } : null;
}

// Remember the local path of a project (per device, informational). Returns
// true when map.json changed.
function rememberProjectPath(entry, projectRoot) {
  const here = norm(resolve(projectRoot));
  entry.config.paths ??= [];
  if (entry.config.paths.includes(here)) return false;
  entry.config.paths.push(here);
  return true;
}

function emptyConfig() {
  return { 'claude-md': '', settings: '', mcp: '', skills: [], agents: [], commands: [], hooks: [], rules: [], files: {}, 'gitignore-lines': [] };
}

// ── SYNC (bazar -> project) ────────────────────────────────────────────────

function syncProject(projectRoot, map) {
  const entry = findProject(map, projectRoot);
  if (!entry) {
    console.error(`  Project not found in map.json: ${norm(projectRoot)}`);
    process.exit(1);
  }

  const { config } = entry;
  const claudeDir = join(projectRoot, '.claude');
  ensureDir(claudeDir);
  if (rememberProjectPath(entry, projectRoot)) writeMap(map);

  // Read old manifest for cleanup
  let oldManifest = null;
  const mPath = manifestPath(projectRoot);
  if (existsSync(mPath)) {
    try { oldManifest = readJSON(mPath); } catch {}
  }

  const managed = {};
  let synced = 0;

  for (const cat of CATEGORIES) {
    const items = config[cat] || [];
    managed[cat] = {};

    for (const itemName of items) {
      const { deploy, full } = parseItemName(itemName);
      const src = bazarItemPath(cat, full);
      const dest = projItemPath(projectRoot, cat, deploy);

      if (!existsSync(src)) {
        console.warn(`  SKIP: ${cat}/${full} not in bazar`);
        continue;
      }

      // Deploy is bazar -> project: bazar is the source of truth, so mirror
      // (prune=true) to remove files deleted upstream.
      if (DIR_CATEGORIES.includes(cat)) pushDirSyncIgnoreAware(src, dest, getIgnorePatterns(full, map.ignore), true);
      else copyFile(src, dest);

      managed[cat][deploy] = full;
      synced++;
    }
  }

  // Sync claude-md
  if (config['claude-md']) {
    const src = join(BAZAR, 'claude-mds', config['claude-md'] + '.md');
    const dest = join(projectRoot, 'CLAUDE.md');
    if (existsSync(src)) { copyFile(src, dest); managed['claude-md'] = config['claude-md']; synced++; }
    else console.warn(`  SKIP: claude-mds/${config['claude-md']}.md not in bazar`);
  }

  // Sync settings
  if (config.settings) {
    const src = join(BAZAR, 'settings', config.settings + '.json');
    const dest = join(projectRoot, '.claude', 'settings.json');
    if (existsSync(src)) { copyFile(src, dest); managed.settings = config.settings; synced++; }
    else console.warn(`  SKIP: settings/${config.settings}.json not in bazar`);
  }

  // Sync mcp
  if (config.mcp) {
    const src = join(BAZAR, 'mcp-configs', config.mcp + '.json');
    const dest = join(projectRoot, '.mcp.json');
    if (existsSync(src)) { copyFile(src, dest); managed.mcp = config.mcp; synced++; }
    else console.warn(`  SKIP: mcp-configs/${config.mcp}.json not in bazar`);
  }

  // Sync files
  managed.files = {};
  const files = config.files || {};
  for (const [bazarName, deployPath] of Object.entries(files)) {
    const src = join(BAZAR, 'files', bazarName);
    const dest = join(projectRoot, deployPath);

    if (!existsSync(src)) {
      console.warn(`  SKIP: files/${bazarName} not in bazar`);
      continue;
    }

    copyFile(src, dest);
    managed.files[bazarName] = deployPath;
    synced++;
  }

  // Sync gitignore-lines (append missing lines to root .gitignore)
  const gitignoreLines = config['gitignore-lines'] || [];
  if (gitignoreLines.length) {
    const giPath = join(projectRoot, '.gitignore');
    let existing = '';
    if (existsSync(giPath)) existing = readFileSync(giPath, 'utf8');
    const marker = '# bazar managed';
    const missing = gitignoreLines.filter(line => !existing.includes(line));
    if (missing.length) {
      const markerLine = existing.includes(marker) ? '' : marker + '\n';
      const append = '\n' + markerLine + missing.join('\n') + '\n';
      writeFileSync(giPath, existing.trimEnd() + append);
      console.log(`  Appended ${missing.length} lines to .gitignore`);
    }
    managed['gitignore-lines'] = gitignoreLines;
  }

  // Cleanup: remove items from old manifest no longer in map
  if (oldManifest?.managed) {
    for (const cat of CATEGORIES) {
      const oldItems = oldManifest.managed[cat] || {};
      const newItems = managed[cat] || {};
      for (const deployName of Object.keys(oldItems)) {
        if (!(deployName in newItems)) {
          deleteItem(projItemPath(projectRoot, cat, deployName));
          console.log(`  Removed: ${cat}/${deployName}`);
        }
      }
    }
    // Cleanup old files
    const oldFiles = oldManifest.managed.files || {};
    const newFiles = managed.files || {};
    for (const [oldBazarName, oldDeploy] of Object.entries(oldFiles)) {
      if (!(oldBazarName in newFiles)) {
        deleteItem(join(projectRoot, oldDeploy));
        console.log(`  Removed: files/${oldBazarName} (${oldDeploy})`);
      }
    }
  }

  // Build ignore map for manifest (only items this project uses)
  const ignoreForManifest = {};
  for (const cat of DIR_CATEGORIES) {
    for (const itemName of (config[cat] || [])) {
      const { deploy, full } = parseItemName(itemName);
      const patterns = getIgnorePatterns(full, map.ignore);
      if (patterns.length) ignoreForManifest[deploy] = patterns;
    }
  }
  managed.ignore = ignoreForManifest;

  // Generate rule files from master
  const ruleCount = generateRuleFiles(projectRoot, config);
  if (ruleCount) console.log(`  Generated ${ruleCount} rule file(s)`);

  // Write manifest
  // Note: the bazar path is intentionally NOT stored here. The per-device path is
  // resolved at runtime via `~/.claude/bazar-paths.json` (keyed by
  // `bazar_remote`) so the manifest stays portable across machines.
  const manifest = {
    project: entry.key,
    bazar_remote: getBazarRemote(),
    synced_at: new Date().toISOString(),
    bazar_commit: getBazarCommit(),
    managed
  };
  manifest.base_hashes = computeBaseHashes(projectRoot, manifest);
  writeJSON(mPath, manifest);

  console.log(`  Synced ${synced} items -> ${norm(projectRoot)}`);
  return manifest;
}

// ── Rule File Generation ─────────────────────────────────────────────────────

function generateRuleFiles(projectRoot, config) {
  let generated = 0;

  // Generate skill-rules.json
  const masterSkills = join(BAZAR, 'master-skill-rules.json');
  if (existsSync(masterSkills)) {
    const master = readJSON(masterSkills);
    const projectSkills = (config.skills || []).map(s => parseItemName(s).deploy);
    const filtered = {
      version: master.version,
      description: master.description,
      skills: {},
      notes: master.notes
    };
    for (const skillName of projectSkills) {
      if (master.skills[skillName]) {
        filtered.skills[skillName] = master.skills[skillName];
      }
    }
    if (Object.keys(filtered.skills).length) {
      // Update skill_overview in notes to only include present skills
      if (filtered.notes?.skill_overview) {
        const overview = {};
        for (const name of Object.keys(filtered.skills)) {
          if (filtered.notes.skill_overview[name]) {
            overview[name] = filtered.notes.skill_overview[name];
          }
        }
        filtered.notes = { ...filtered.notes, skill_overview: overview };
      }
      const dest = join(projectRoot, '.claude', 'skills', 'skill-rules.json');
      ensureDir(dirname(dest));
      writeJSON(dest, filtered);
      generated++;
    }
  }

  // Generate agent-rules.json
  const masterAgents = join(BAZAR, 'master-agent-rules.json');
  if (existsSync(masterAgents)) {
    const master = readJSON(masterAgents);
    const projectAgents = (config.agents || []).map(a => parseItemName(a).deploy);
    const filtered = {
      version: master.version,
      description: master.description,
      agents: {},
      notes: master.notes
    };
    for (const agentName of projectAgents) {
      if (master.agents[agentName]) {
        filtered.agents[agentName] = master.agents[agentName];
      }
    }
    if (Object.keys(filtered.agents).length) {
      // Update agent_overview in notes to only include present agents
      if (filtered.notes?.agent_overview) {
        const overview = {};
        for (const name of Object.keys(filtered.agents)) {
          if (filtered.notes.agent_overview[name]) {
            overview[name] = filtered.notes.agent_overview[name];
          }
        }
        filtered.notes = { ...filtered.notes, agent_overview: overview };
      }
      const dest = join(projectRoot, '.claude', 'agents', 'agent-rules.json');
      ensureDir(dirname(dest));
      writeJSON(dest, filtered);
      generated++;
    }
  }

  return generated;
}

function pushRuleFiles(projectRoot) {
  let pushed = 0;

  // Push skill-rules.json changes back to master
  const skillRulesPath = join(projectRoot, '.claude', 'skills', 'skill-rules.json');
  const masterSkillsPath = join(BAZAR, 'master-skill-rules.json');
  if (existsSync(skillRulesPath) && existsSync(masterSkillsPath)) {
    const local = readJSON(skillRulesPath);
    const master = readJSON(masterSkillsPath);
    let changed = false;
    for (const [name, rules] of Object.entries(local.skills || {})) {
      const localHash = createHash('md5').update(JSON.stringify(rules)).digest('hex');
      const masterHash = master.skills[name] ? createHash('md5').update(JSON.stringify(master.skills[name])).digest('hex') : null;
      if (localHash !== masterHash) {
        master.skills[name] = rules;
        changed = true;
      }
    }
    // Also merge skill_overview
    if (local.notes?.skill_overview) {
      if (!master.notes) master.notes = {};
      if (!master.notes.skill_overview) master.notes.skill_overview = {};
      for (const [name, overview] of Object.entries(local.notes.skill_overview)) {
        master.notes.skill_overview[name] = overview;
      }
    }
    if (changed) {
      writeJSON(masterSkillsPath, master);
      pushed++;
    }
  }

  // Push agent-rules.json changes back to master
  const agentRulesPath = join(projectRoot, '.claude', 'agents', 'agent-rules.json');
  const masterAgentsPath = join(BAZAR, 'master-agent-rules.json');
  if (existsSync(agentRulesPath) && existsSync(masterAgentsPath)) {
    const local = readJSON(agentRulesPath);
    const master = readJSON(masterAgentsPath);
    let changed = false;
    for (const [name, rules] of Object.entries(local.agents || {})) {
      const localHash = createHash('md5').update(JSON.stringify(rules)).digest('hex');
      const masterHash = master.agents[name] ? createHash('md5').update(JSON.stringify(master.agents[name])).digest('hex') : null;
      if (localHash !== masterHash) {
        master.agents[name] = rules;
        changed = true;
      }
    }
    if (local.notes?.agent_overview) {
      if (!master.notes) master.notes = {};
      if (!master.notes.agent_overview) master.notes.agent_overview = {};
      for (const [name, overview] of Object.entries(local.notes.agent_overview)) {
        master.notes.agent_overview[name] = overview;
      }
    }
    if (changed) {
      writeJSON(masterAgentsPath, master);
      pushed++;
    }
  }

  return pushed;
}

// ── Filtered Directory Push ──────────────────────────────────────────────────

function deleteNonIgnored(dir, rootDir, patterns) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (shouldIgnore(entry.name)) continue;
    const full = join(dir, entry.name);
    const rel = norm(relative(rootDir, full));
    if (shouldSyncIgnore(rel, patterns)) continue;

    if (entry.isDirectory()) {
      deleteNonIgnored(full, rootDir, patterns);
      try { const r = readdirSync(full); if (!r.length) rmSync(full); } catch {}
    } else {
      unlinkSync(full);
    }
  }
}

function copyDirFiltered(src, dest, srcRoot, patterns) {
  ensureDir(dest);
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (shouldIgnore(entry.name)) continue;
    const srcFull = join(src, entry.name);
    const destFull = join(dest, entry.name);
    const rel = norm(relative(srcRoot, srcFull));
    if (shouldSyncIgnore(rel, patterns)) continue;
    if (entry.isDirectory()) copyDirFiltered(srcFull, destFull, srcRoot, patterns);
    else copyFile(srcFull, destFull);
  }
}

// Files present in dest but absent from src (respecting ignore rules). A
// destructive mirror would delete these; an additive push preserves them.
function findDestOnly(src, dest, patterns = []) {
  if (!existsSync(dest)) return [];
  return getAllFiles(dest, dest, patterns)
    .map(f => norm(relative(dest, f)))
    .filter(rel => !existsSync(join(src, rel)));
}

// Push a directory item (project -> bazar, or bazar -> project on deploy).
//   prune=false (default): ADDITIVE. Overlay src onto dest; never delete files
//     that exist in dest but are absent from src. This is the safe default that
//     stops one device from clobbering another's content when two devices have
//     divergent .claude/ trees (the multi-device divergence class of bug).
//   prune=true (--prune/--mirror, and always on deploy): destructive mirror,
//     dest becomes an exact copy of src. Use only for intentional deletes/renames.
function pushDirSyncIgnoreAware(src, dest, patterns = [], prune = false) {
  if (prune) {
    if (!patterns.length) {
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
      copyDir(src, dest);
    } else {
      if (existsSync(dest)) deleteNonIgnored(dest, dest, patterns);
      copyDirFiltered(src, dest, src, patterns);
    }
    return;
  }
  if (patterns.length) copyDirFiltered(src, dest, src, patterns);
  else copyDir(src, dest);
}

// ── Change Detection ────────────────────────────────────────────────────────

function getChangedItems(projectRoot) {
  const mPath = manifestPath(projectRoot);
  if (!existsSync(mPath)) return [];

  const manifest = readJSON(mPath);
  const ignoreMap = manifest.managed.ignore || {};
  const changed = [];

  for (const cat of CATEGORIES) {
    const items = manifest.managed[cat] || {};
    for (const [deploy, full] of Object.entries(items)) {
      const patterns = DIR_CATEGORIES.includes(cat) ? (ignoreMap[deploy] || []) : [];
      const projHash = hashPath(projItemPath(projectRoot, cat, deploy), patterns);
      const bazarHash = hashPath(bazarItemPath(cat, full), patterns);
      if (!projHash) continue;
      if (!bazarHash) changed.push({ category: cat, deploy, full, status: 'local-only' });
      else if (projHash !== bazarHash) changed.push({ category: cat, deploy, full, status: 'changed' });
    }
  }

  if (manifest.managed['claude-md']) {
    const ph = hashPath(join(projectRoot, 'CLAUDE.md'));
    const lh = hashPath(join(BAZAR, 'claude-mds', manifest.managed['claude-md'] + '.md'));
    if (ph && lh && ph !== lh) changed.push({ category: 'claude-md', deploy: 'CLAUDE.md', full: manifest.managed['claude-md'], status: 'changed' });
  }
  if (manifest.managed.settings) {
    const ph = hashPath(join(projectRoot, '.claude', 'settings.json'));
    const lh = hashPath(join(BAZAR, 'settings', manifest.managed.settings + '.json'));
    if (ph && lh && ph !== lh) changed.push({ category: 'settings', deploy: 'settings.json', full: manifest.managed.settings, status: 'changed' });
  }
  if (manifest.managed.mcp) {
    const ph = hashPath(join(projectRoot, '.mcp.json'));
    const lh = hashPath(join(BAZAR, 'mcp-configs', manifest.managed.mcp + '.json'));
    if (ph && lh && ph !== lh) changed.push({ category: 'mcp', deploy: '.mcp.json', full: manifest.managed.mcp, status: 'changed' });
  }
  const files = manifest.managed.files || {};
  for (const [bazarName, deployPath] of Object.entries(files)) {
    const ph = hashPath(join(projectRoot, deployPath));
    const lh = hashPath(join(BAZAR, 'files', bazarName));
    if (ph && lh && ph !== lh) changed.push({ category: 'files', deploy: deployPath, full: bazarName, status: 'changed' });
  }

  return changed;
}

function itemPaths(projectRoot, manifest, item) {
  const ignoreMap = manifest.managed.ignore || {};
  if (CATEGORIES.includes(item.category)) {
    return {
      src: projItemPath(projectRoot, item.category, item.deploy),
      dest: bazarItemPath(item.category, item.full),
      patterns: DIR_CATEGORIES.includes(item.category) ? (ignoreMap[item.deploy] || []) : []
    };
  }
  if (item.category === 'claude-md') return { src: join(projectRoot, 'CLAUDE.md'), dest: join(BAZAR, 'claude-mds', item.full + '.md'), patterns: [] };
  if (item.category === 'settings') return { src: join(projectRoot, '.claude', 'settings.json'), dest: join(BAZAR, 'settings', item.full + '.json'), patterns: [] };
  if (item.category === 'mcp') return { src: join(projectRoot, '.mcp.json'), dest: join(BAZAR, 'mcp-configs', item.full + '.json'), patterns: [] };
  if (item.category === 'files') return { src: join(projectRoot, item.deploy), dest: join(BAZAR, 'files', item.full), patterns: [] };
  return null;
}

function computeBaseHashes(projectRoot, manifest) {
  // Records the agreed two-sided state ({proj, bazar} hash per item) after a
  // sync or push, so a later push can detect both-sides-changed divergence
  // instead of silently clobbering a bazar item with a stale local copy.
  const hashes = {};
  const managed = manifest.managed;
  const items = [];
  for (const cat of CATEGORIES) {
    for (const [deploy, full] of Object.entries(managed[cat] || {})) items.push({ category: cat, deploy, full });
  }
  if (managed['claude-md']) items.push({ category: 'claude-md', deploy: 'CLAUDE.md', full: managed['claude-md'] });
  if (managed.settings) items.push({ category: 'settings', deploy: 'settings.json', full: managed.settings });
  if (managed.mcp) items.push({ category: 'mcp', deploy: '.mcp.json', full: managed.mcp });
  for (const [bazarName, deployPath] of Object.entries(managed.files || {})) items.push({ category: 'files', deploy: deployPath, full: bazarName });
  for (const item of items) {
    const p = itemPaths(projectRoot, manifest, item);
    if (!p) continue;
    const proj = hashPath(p.src, p.patterns);
    const bazar = hashPath(p.dest, p.patterns);
    if (proj || bazar) hashes[`${item.category}/${item.full}`] = { proj, bazar };
  }
  return hashes;
}

function checkPushPrecondition(projectRoot, manifest, item) {
  const paths = itemPaths(projectRoot, manifest, item);
  if (!paths) return { ok: false, reason: 'unresolved-path' };

  const base = (manifest.base_hashes || {})[`${item.category}/${item.full}`];
  const bazarHash = hashPath(paths.dest, paths.patterns);
  const hasCompleteBase = base
    && Object.prototype.hasOwnProperty.call(base, 'proj')
    && Object.prototype.hasOwnProperty.call(base, 'bazar');

  // A missing base is safe only when the destination is also missing. That is
  // a genuinely new bazar item. If the destination exists, the manifest is
  // legacy or incomplete and there is no safe expected value to compare.
  if (!hasCompleteBase) {
    return bazarHash === null
      ? { ok: true, reason: null }
      : { ok: false, reason: 'missing-base' };
  }

  const projHash = hashPath(paths.src, paths.patterns);
  if (bazarHash === base.bazar) return { ok: true, reason: null };
  return { ok: false, reason: projHash === base.proj ? 'stale' : 'conflict' };
}

function confirm(message) {
  if (!process.stdin.isTTY) return Promise.resolve(true);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(message, answer => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

// ── PUSH (project -> bazar) ────────────────────────────────────────────────

async function pushProject(projectRoot, categoryFilter, itemFilter, skipConfirm, prune = false, force = false) {
  const mPath = manifestPath(projectRoot);
  if (!existsSync(mPath)) { console.error('  No manifest. Run sync first.'); process.exit(1); }
  const manifest = readJSON(mPath);
  const ignoreMap = manifest.managed.ignore || {};

  if (force && (!categoryFilter || !itemFilter)) {
    console.error('  --force requires --category <cat> --item <name>.');
    process.exitCode = 1;
    return;
  }

  const ancestor = isBazarCommitAncestor(manifest.bazar_commit);
  if (!force && ancestor === false) {
    console.error(`  REFUSED: manifest bazar_commit ${manifest.bazar_commit} is not an ancestor of bazar HEAD.`);
    console.error('  Sync first, or use a targeted --force only for a deliberate rollback.');
    process.exitCode = 1;
    return;
  }

  // Detect changed items
  const allChanged = getChangedItems(projectRoot);

  // Apply filters
  let toPush = allChanged;
  if (categoryFilter) {
    toPush = toPush.filter(i => i.category === categoryFilter);
    if (itemFilter) {
      toPush = toPush.filter(i => i.deploy === itemFilter || i.full === itemFilter);
    }
  }

  // Preflight every selected item. --item narrows the selection but does not
  // weaken the compare-and-swap precondition. Only a targeted --force bypasses
  // it for a deliberate rollback.
  const conflicts = [];
  const stale = [];
  const missingBase = [];
  const unresolved = [];
  if (!force) {
    toPush = toPush.filter(item => {
      const result = checkPushPrecondition(projectRoot, manifest, item);
      if (result.ok) return true;
      if (result.reason === 'stale') stale.push(item);
      else if (result.reason === 'conflict') conflicts.push(item);
      else if (result.reason === 'missing-base') missingBase.push(item);
      else unresolved.push(item);
      return false;
    });
  }

  if (missingBase.length) {
    console.log('\n  NO BASE: bazar item exists but this project has no complete base. Skipped:');
    for (const item of missingBase) console.log(`    ${item.category}/${item.deploy}`);
    console.log('  Sync to adopt the bazar state, or use a targeted --force for a deliberate rollback.');
  }
  if (stale.length) {
    console.log('\n  STALE (bazar moved on, nothing authored here). Not pushed:');
    for (const s of stale) console.log(`    ${s.category}/${s.deploy}`);
    console.log('  Run a plain sync to bring this project up to date.');
  }
  if (conflicts.length) {
    console.log('\n  CONFLICT: both sides changed since this project last synced. Skipped:');
    for (const c of conflicts) console.log(`    ${c.category}/${c.deploy}`);
    console.log('  Resolve per item: run a plain sync to take the bazar version,');
    console.log("  or add --force to a targeted push to take this device's version.");
  }
  if (unresolved.length) {
    console.error('\n  ERROR: could not resolve paths for these items. Skipped:');
    for (const item of unresolved) console.error(`    ${item.category}/${item.deploy}`);
  }

  if (!toPush.length) {
    const scope = categoryFilter ? ` in ${categoryFilter}${itemFilter ? '/' + itemFilter : ''}` : '';
    console.log(`  No changes to push${scope}`);
    return;
  }

  // Show what will be pushed
  console.log(`\n  Changes to push:`);
  for (const item of toPush) {
    console.log(`    ${item.category}/${item.deploy} (${item.status})`);
  }

  // Confirm if unfiltered and not --yes
  if (!categoryFilter && !skipConfirm) {
    const ok = await confirm(`\n  Push ${toPush.length} item(s)? (y/n) `);
    if (!ok) { console.log('  Aborted'); return; }
  }

  let pushed = 0;
  const pushedItems = [];

  for (const item of toPush) {
    const paths = itemPaths(projectRoot, manifest, item);
    if (!paths || !existsSync(paths.src)) continue;

    // Re-check immediately before the write. A concurrent push may have moved
    // the bazar after preflight or while the confirmation prompt was open.
    if (!force) {
      const result = checkPushPrecondition(projectRoot, manifest, item);
      if (!result.ok) {
        console.log(`    SKIP: ${item.category}/${item.deploy} (precondition changed: ${result.reason})`);
        continue;
      }
    }

    if (DIR_CATEGORIES.includes(item.category)) {
      if (!prune) {
        const preserved = findDestOnly(paths.src, paths.dest, paths.patterns);
        if (preserved.length) {
          console.log(`    preserved ${preserved.length} bazar-only file(s) under ${item.category}/${item.deploy} (absent on this device):`);
          for (const rel of preserved.slice(0, 10)) console.log(`      + ${rel}`);
          if (preserved.length > 10) console.log(`      ... and ${preserved.length - 10} more`);
          console.log(`      run with --prune if these deletions are intentional`);
        }
      }
      pushDirSyncIgnoreAware(paths.src, paths.dest, paths.patterns, prune);
    } else copyFile(paths.src, paths.dest);

    pushed++;
    pushedItems.push(item);
  }

  // Push rule files if pushing skills
  if (pushedItems.length && (!categoryFilter || categoryFilter === 'skills')) {
    const rulePushed = pushRuleFiles(projectRoot);
    if (rulePushed) {
      console.log(`  Merged ${rulePushed} rule file(s) into master`);
      pushed += rulePushed;
    }
  }

  // Record the new agreed two-sided state for pushed items
  if (pushedItems.length) {
    const bh = manifest.base_hashes || {};
    for (const item of pushedItems) {
      const paths = itemPaths(projectRoot, manifest, item);
      if (!paths) continue;
      const proj = hashPath(paths.src, paths.patterns);
      const bazar = hashPath(paths.dest, paths.patterns);
      if (proj || bazar) bh[`${item.category}/${item.full}`] = { proj, bazar };
    }
    manifest.base_hashes = bh;
    writeJSON(mPath, manifest);
  }

  const name = basename(projectRoot);
  const scope = categoryFilter ? `${categoryFilter}${itemFilter ? '/' + itemFilter : ''}` : 'changes';
  console.log(`  Pushed ${pushed} item(s) to bazar`);

  if (gitCommitAndPush(`sync: pushed ${scope} from ${name}`)) {
    console.log('  Committed and pushed');
  }
}

// ── DIFF ─────────────────────────────────────────────────────────────────────

function diffProject(projectRoot) {
  const mPath = manifestPath(projectRoot);
  if (!existsSync(mPath)) { console.error('  No manifest. Run sync first.'); process.exit(1); }

  const manifest = readJSON(mPath);
  const ignoreMap = manifest.managed.ignore || {};
  const rows = [];

  for (const cat of CATEGORIES) {
    const items = manifest.managed[cat] || {};
    for (const [deploy, full] of Object.entries(items)) {
      const patterns = DIR_CATEGORIES.includes(cat) ? (ignoreMap[deploy] || []) : [];
      const projHash = hashPath(projItemPath(projectRoot, cat, deploy), patterns);
      const bazarHash = hashPath(bazarItemPath(cat, full), patterns);

      let status;
      if (!projHash && !bazarHash) status = 'missing';
      else if (!projHash) status = 'bazar-only';
      else if (!bazarHash) status = 'local-only';
      else if (projHash === bazarHash) status = 'in-sync';
      else status = 'changed';

      rows.push({ category: cat, item: deploy, bazar: full, status });
    }
  }

  // Check claude-md and settings
  if (manifest.managed['claude-md']) {
    const ph = hashPath(join(projectRoot, 'CLAUDE.md'));
    const lh = hashPath(join(BAZAR, 'claude-mds', manifest.managed['claude-md'] + '.md'));
    rows.push({ category: 'claude-md', item: 'CLAUDE.md', bazar: manifest.managed['claude-md'],
      status: ph === lh ? 'in-sync' : (ph && lh ? 'changed' : 'missing') });
  }

  if (manifest.managed.settings) {
    const ph = hashPath(join(projectRoot, '.claude', 'settings.json'));
    const lh = hashPath(join(BAZAR, 'settings', manifest.managed.settings + '.json'));
    rows.push({ category: 'settings', item: 'settings.json', bazar: manifest.managed.settings,
      status: ph === lh ? 'in-sync' : (ph && lh ? 'changed' : 'missing') });
  }

  if (manifest.managed.mcp) {
    const ph = hashPath(join(projectRoot, '.mcp.json'));
    const lh = hashPath(join(BAZAR, 'mcp-configs', manifest.managed.mcp + '.json'));
    rows.push({ category: 'mcp', item: '.mcp.json', bazar: manifest.managed.mcp,
      status: ph === lh ? 'in-sync' : (ph && lh ? 'changed' : 'missing') });
  }

  // Check files
  const files = manifest.managed.files || {};
  for (const [bazarName, deployPath] of Object.entries(files)) {
    const ph = hashPath(join(projectRoot, deployPath));
    const lh = hashPath(join(BAZAR, 'files', bazarName));
    rows.push({ category: 'files', item: deployPath, bazar: bazarName,
      status: ph === lh ? 'in-sync' : (ph && lh ? 'changed' : 'missing') });
  }

  printTable(rows);
  return rows;
}

function printTable(rows) {
  if (!rows.length) { console.log('  No managed items.'); return; }

  const w = { cat: 10, item: 30, bazar: 35, status: 14 };
  const pad = (s, n) => String(s).padEnd(n);

  console.log();
  console.log(`  ${pad('CATEGORY', w.cat)} ${pad('ITEM', w.item)} ${pad('BAZAR NAME', w.bazar)} STATUS`);
  console.log(`  ${'-'.repeat(w.cat)} ${'-'.repeat(w.item)} ${'-'.repeat(w.bazar)} ${'-'.repeat(w.status)}`);

  for (const r of rows) {
    const icon = r.status === 'in-sync' ? '=' : r.status === 'changed' ? '*' : '!';
    console.log(`  ${pad(r.category, w.cat)} ${pad(r.item, w.item)} ${pad(r.bazar, w.bazar)} ${icon} ${r.status}`);
  }

  const changed = rows.filter(r => r.status !== 'in-sync').length;
  const synced = rows.filter(r => r.status === 'in-sync').length;
  console.log(`\n  ${synced} in sync, ${changed} changed/missing`);
}

// ── LIST ─────────────────────────────────────────────────────────────────────

function listBazar(map) {
  console.log('\n  === Bazar Contents ===\n');

  for (const cat of CATEGORIES) {
    const catDir = join(BAZAR, cat);
    if (!existsSync(catDir)) continue;

    const entries = readdirSync(catDir, { withFileTypes: true });
    const items = [];

    for (const entry of entries) {
      if (DIR_CATEGORIES.includes(cat) && entry.isDirectory()) items.push(entry.name);
      else if (FILE_CATEGORIES.includes(cat) && entry.isFile() && entry.name.endsWith('.md')) items.push(entry.name.replace('.md', ''));
    }

    if (!items.length) continue;

    console.log(`  ${cat.toUpperCase()} (${items.length}):`);
    for (const item of items.sort()) {
      const { deploy, variant } = parseItemName(item);
      const tag = variant ? ` [variant: ${variant}]` : '';
      const users = Object.entries(map.projects)
        .filter(([, c]) => (c[cat] || []).includes(item))
        .map(([p]) => basename(p));
      const usedBy = users.length ? ` <- ${users.join(', ')}` : '';
      console.log(`    ${deploy}${tag}${usedBy}`);
    }
    console.log();
  }

  // claude-mds
  const cmDir = join(BAZAR, 'claude-mds');
  if (existsSync(cmDir)) {
    const files = readdirSync(cmDir).filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));
    if (files.length) {
      console.log(`  CLAUDE.MD FILES (${files.length}):`);
      for (const f of files.sort()) {
        const users = Object.entries(map.projects).filter(([, c]) => c['claude-md'] === f).map(([p]) => basename(p));
        console.log(`    ${f}${users.length ? ` <- ${users.join(', ')}` : ''}`);
      }
      console.log();
    }
  }

  // settings
  const sDir = join(BAZAR, 'settings');
  if (existsSync(sDir)) {
    const files = readdirSync(sDir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
    if (files.length) {
      console.log(`  SETTINGS FILES (${files.length}):`);
      for (const f of files.sort()) {
        const users = Object.entries(map.projects).filter(([, c]) => c.settings === f).map(([p]) => basename(p));
        console.log(`    ${f}${users.length ? ` <- ${users.join(', ')}` : ''}`);
      }
      console.log();
    }
  }

  // mcp-configs
  const mcpDir = join(BAZAR, 'mcp-configs');
  if (existsSync(mcpDir)) {
    const files = readdirSync(mcpDir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
    if (files.length) {
      console.log(`  MCP CONFIGS (${files.length}):`);
      for (const f of files.sort()) {
        const users = Object.entries(map.projects).filter(([, c]) => c.mcp === f).map(([p]) => basename(p));
        console.log(`    ${f}${users.length ? ` <- ${users.join(', ')}` : ''}`);
      }
      console.log();
    }
  }

  // files
  const fDir = join(BAZAR, 'files');
  if (existsSync(fDir)) {
    const items = readdirSync(fDir, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name);
    if (items.length) {
      console.log(`  FILES (${items.length}):`);
      for (const item of items.sort()) {
        const { deploy, variant } = parseItemName(item);
        const tag = variant ? ` [variant: ${variant}]` : '';
        const users = [];
        for (const [p, c] of Object.entries(map.projects)) {
          if (c.files && item in c.files) users.push(`${basename(p)} -> ${c.files[item]}`);
        }
        const usedBy = users.length ? ` <- ${users.join(', ')}` : '';
        console.log(`    ${deploy}${tag}${usedBy}`);
      }
      console.log();
    }
  }

  // profiles
  const profiles = map.profiles || {};
  if (Object.keys(profiles).length) {
    console.log(`  === Profiles ===\n`);
    for (const [name, config] of Object.entries(profiles)) {
      const total = CATEGORIES.reduce((n, c) => n + (config[c] || []).length, 0)
        + (config['claude-md'] ? 1 : 0) + (config.settings ? 1 : 0) + (config.mcp ? 1 : 0)
        + Object.keys(config.files || {}).length;
      console.log(`  ${name} (${total} items)`);
      for (const cat of CATEGORIES) {
        const items = config[cat] || [];
        if (items.length) console.log(`    ${cat}: ${items.join(', ')}`);
      }
      if (config['claude-md']) console.log(`    claude-md: ${config['claude-md']}`);
      if (config.settings) console.log(`    settings: ${config.settings}`);
      if (config.mcp) console.log(`    mcp: ${config.mcp}`);
      const f = config.files || {};
      if (Object.keys(f).length) console.log(`    files: ${Object.entries(f).map(([k, v]) => `${k} -> ${v}`).join(', ')}`);
      console.log();
    }
  }

  // projects
  console.log('  === Projects ===\n');
  for (const [key, config] of Object.entries(map.projects)) {
    const total = CATEGORIES.reduce((n, c) => n + (config[c] || []).length, 0)
      + (config['claude-md'] ? 1 : 0) + (config.settings ? 1 : 0) + (config.mcp ? 1 : 0)
      + Object.keys(config.files || {}).length;
    console.log(`  ${key} (${total} items)`);
    if (config.paths?.length) console.log(`    paths: ${config.paths.join(', ')}`);
    for (const cat of CATEGORIES) {
      const items = config[cat] || [];
      if (items.length) console.log(`    ${cat}: ${items.join(', ')}`);
    }
    if (config['claude-md']) console.log(`    claude-md: ${config['claude-md']}`);
    if (config.settings) console.log(`    settings: ${config.settings}`);
    if (config.mcp) console.log(`    mcp: ${config.mcp}`);
    const f = config.files || {};
    if (Object.keys(f).length) console.log(`    files: ${Object.entries(f).map(([k, v]) => `${k} -> ${v}`).join(', ')}`);
    console.log();
  }
}

// ── ADD / REMOVE ─────────────────────────────────────────────────────────────

function addItem(projectRoot, category, itemName, map, deployPath) {
  const entry = findProject(map, projectRoot);
  if (!entry) { console.error(`  Project not in map.json: ${norm(projectRoot)}`); process.exit(1); }

  // Handle files category separately
  if (category === 'files') {
    if (!deployPath) { console.error('  Files need a deploy path: --add files <bazar-name> <deploy-path>'); process.exit(1); }
    const src = join(BAZAR, 'files', itemName);
    if (!existsSync(src)) { console.error(`  Not in bazar: files/${itemName}`); process.exit(1); }
    if (!entry.config.files) entry.config.files = {};
    if (itemName in entry.config.files) { console.log(`  Already mapped: files/${itemName}`); return; }
    entry.config.files[itemName] = deployPath;
    writeMap(map);
    console.log(`  Added files/${itemName} -> ${deployPath}`);
    syncProject(projectRoot, map);
    return;
  }

  if (!CATEGORIES.includes(category)) {
    console.error(`  Invalid category: ${category}. Use: ${CATEGORIES.join(', ')}, files`);
    process.exit(1);
  }

  const src = bazarItemPath(category, parseItemName(itemName).full);
  if (!existsSync(src)) { console.error(`  Not in bazar: ${category}/${itemName}`); process.exit(1); }

  if (entry.config[category].includes(itemName)) { console.log(`  Already mapped: ${category}/${itemName}`); return; }

  entry.config[category].push(itemName);
  writeMap(map);
  console.log(`  Added ${category}/${itemName} to ${basename(projectRoot)}`);
  syncProject(projectRoot, map);
}

function removeItemFromProject(projectRoot, category, itemName, map) {
  const entry = findProject(map, projectRoot);
  if (!entry) { console.error(`  Project not in map.json`); process.exit(1); }

  // Handle files category separately
  if (category === 'files') {
    if (!entry.config.files || !(itemName in entry.config.files)) {
      console.error(`  Not mapped: files/${itemName}`);
      return;
    }
    const deployPath = entry.config.files[itemName];
    delete entry.config.files[itemName];
    writeMap(map);
    deleteItem(join(projectRoot, deployPath));
    syncProject(projectRoot, map);
    console.log(`  Removed files/${itemName} (${deployPath})`);
    return;
  }

  if (!CATEGORIES.includes(category)) {
    console.error(`  Invalid category: ${category}`);
    process.exit(1);
  }

  // Match by full name or deploy name
  let idx = entry.config[category].indexOf(itemName);
  if (idx === -1) idx = entry.config[category].findIndex(i => parseItemName(i).deploy === itemName);
  if (idx === -1) { console.error(`  Not mapped: ${category}/${itemName}`); return; }

  const removed = entry.config[category].splice(idx, 1)[0];
  writeMap(map);

  const { deploy } = parseItemName(removed);
  deleteItem(projItemPath(projectRoot, category, deploy));
  syncProject(projectRoot, map);
  console.log(`  Removed ${category}/${removed}`);
}

// ── INIT ─────────────────────────────────────────────────────────────────────

function initProject(projectRoot, fromPath, profileName, map) {
  const normRoot = norm(resolve(projectRoot));
  const key = projectKey(projectRoot);
  if (findProject(map, projectRoot)) { console.error(`  Already in map.json: ${key}`); process.exit(1); }

  let config;
  if (profileName) {
    const profiles = map.profiles || {};
    if (!(profileName in profiles)) {
      console.error(`  Profile not found: ${profileName}. Available: ${Object.keys(profiles).join(', ') || 'none'}`);
      process.exit(1);
    }
    config = JSON.parse(JSON.stringify(profiles[profileName]));
    console.log(`  Applied profile: ${profileName}`);
  } else if (fromPath) {
    const source = findProject(map, fromPath);
    if (!source) { console.error(`  Source not found: ${fromPath}`); process.exit(1); }
    config = JSON.parse(JSON.stringify(source.config));
    console.log(`  Copied config from ${norm(fromPath)}`);
  } else {
    config = emptyConfig();
  }

  // Ensure files field exists
  if (!config.files) config.files = {};
  config.paths = [normRoot];

  map.projects[key] = config;
  writeMap(map);
  console.log(`  Added ${key} (${normRoot}) to map.json`);

  // First sync right away: it writes the manifest the hooks need. Runs
  // before ensureBazarHooks so a profile settings.json can't drop them.
  syncProject(projectRoot, map);
  ensureBazarHooks(projectRoot);
}

const BAZAR_HOOKS = [
  { event: 'Stop', script: 'bazar-sync.mjs', timeout: 30 },
  { event: 'SessionStart', matcher: 'startup|resume', script: 'bazar-session-start.mjs', timeout: 60 },
];

// One-shot at init: register the BazarHook entries in the project's own
// settings.json (created if missing). Not recorded in the manifest, so later
// syncs never touch the rest of the file.
function ensureBazarHooks(projectRoot) {
  const setPath = join(projectRoot, '.claude', 'settings.json');
  let settings = {};
  if (existsSync(setPath)) {
    try { settings = readJSON(setPath); }
    catch (e) { console.warn(`  SKIP BazarHook entries: settings.json unreadable (${e.message})`); return; }
  }
  settings.hooks ??= {};
  let added = 0;
  for (const { event, matcher, script, timeout } of BAZAR_HOOKS) {
    settings.hooks[event] ??= [];
    const present = settings.hooks[event].some(g => (g.hooks || []).some(h => h.command?.includes(script)));
    if (present) { console.log(`  ${event} hook already in settings.json`); continue; }
    const command = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/BazarHook/${script}"`;
    settings.hooks[event].push({ ...(matcher && { matcher }), hooks: [{ type: 'command', command, timeout }] });
    console.log(`  Added BazarHook ${event} entry to settings.json`);
    added++;
  }
  if (!added) return;
  ensureDir(dirname(setPath));
  writeJSON(setPath, settings);
}

// ── SEED (project -> bazar, initial population) ────────────────────────────

function seedProject(projectRoot, name, map) {
  const normRoot = norm(resolve(projectRoot));
  const claudeDir = join(projectRoot, '.claude');

  if (!existsSync(claudeDir)) { console.error(`  No .claude dir at ${projectRoot}`); process.exit(1); }

  const config = emptyConfig();
  let imported = 0;

  // Skills (directories)
  const skillsDir = join(claudeDir, 'skills');
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      copyDir(join(skillsDir, entry.name), join(BAZAR, 'skills', entry.name));
      config.skills.push(entry.name);
      imported++;
    }
  }

  // Agents (.md files only)
  const agentsDir = join(claudeDir, 'agents');
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      copyFile(join(agentsDir, entry.name), join(BAZAR, 'agents', entry.name));
      config.agents.push(entry.name.replace('.md', ''));
      imported++;
    }
  }

  // Commands (.md files only, skip archive/)
  const cmdsDir = join(claudeDir, 'commands');
  if (existsSync(cmdsDir)) {
    for (const entry of readdirSync(cmdsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      copyFile(join(cmdsDir, entry.name), join(BAZAR, 'commands', entry.name));
      config.commands.push(entry.name.replace('.md', ''));
      imported++;
    }
  }

  // Hooks (directories only)
  const hooksDir = join(claudeDir, 'hooks');
  if (existsSync(hooksDir)) {
    for (const entry of readdirSync(hooksDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      copyDir(join(hooksDir, entry.name), join(BAZAR, 'hooks', entry.name));
      config.hooks.push(entry.name);
      imported++;
    }
  }

  // CLAUDE.md
  if (name) {
    const cmdPath = join(projectRoot, 'CLAUDE.md');
    if (existsSync(cmdPath)) {
      copyFile(cmdPath, join(BAZAR, 'claude-mds', name + '.md'));
      config['claude-md'] = name;
      imported++;
    }

    // settings.json
    const setPath = join(claudeDir, 'settings.json');
    if (existsSync(setPath)) {
      copyFile(setPath, join(BAZAR, 'settings', name + '.json'));
      config.settings = name;
      imported++;
    }

    // .mcp.json
    const mcpPath = join(projectRoot, '.mcp.json');
    if (existsSync(mcpPath)) {
      copyFile(mcpPath, join(BAZAR, 'mcp-configs', name + '.json'));
      config.mcp = name;
      imported++;
    }
  }

  // Update map
  const key = projectKey(projectRoot);
  config.paths = [normRoot];
  map.projects[key] = config;
  writeMap(map);

  // Write manifest
  const managed = { 'claude-md': config['claude-md'], settings: config.settings, mcp: config.mcp || '', files: {} };
  for (const cat of CATEGORIES) {
    managed[cat] = {};
    for (const item of config[cat]) {
      managed[cat][parseItemName(item).deploy] = item;
    }
  }

  const manifest = {
    project: key,
    bazar_remote: getBazarRemote(),
    synced_at: new Date().toISOString(),
    bazar_commit: getBazarCommit(),
    managed
  };
  manifest.base_hashes = computeBaseHashes(projectRoot, manifest);
  writeJSON(manifestPath(projectRoot), manifest);

  // Merge any existing rule files into master
  pushRuleFiles(projectRoot);

  console.log(`  Imported ${imported} items from ${norm(projectRoot)}`);
  if (name) console.log(`  claude-md -> ${name}.md, settings -> ${name}.json${config.mcp ? `, mcp -> ${name}.json` : ''}`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    command: 'sync', project: null, all: false,
    from: null, name: null, profile: null,
    category: null, item: null, deployPath: null,
    yes: false, prune: false, force: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--push': parsed.command = 'push'; break;
      case '--diff': parsed.command = 'diff'; break;
      case '--list': parsed.command = 'list'; break;
      case '--seed': parsed.command = 'seed'; break;
      case '--all': parsed.all = true; break;
      case '--init': parsed.command = 'init'; break;
      case '--link': parsed.command = 'link'; break;
      case '--unlink': parsed.command = 'unlink'; break;
      case '--project': parsed.project = args[++i]; break;
      case '--from': parsed.from = args[++i]; break;
      case '--name': parsed.name = args[++i]; break;
      case '--profile': parsed.profile = args[++i]; break;
      case '--category': parsed.category = args[++i]; break;
      case '--item': parsed.item = args[++i]; break;
      case '--yes': case '-y': parsed.yes = true; break;
      case '--prune': case '--mirror': parsed.prune = true; break;
      case '--force': parsed.force = true; break;
      case '--add':
        parsed.command = 'add';
        parsed.category = args[++i];
        parsed.item = args[++i];
        // For files, next arg is the deploy path
        if (parsed.category === 'files' && i + 1 < args.length && !args[i + 1]?.startsWith('--')) {
          parsed.deployPath = args[++i];
        }
        break;
      case '--remove':
        parsed.command = 'remove';
        parsed.category = args[++i];
        parsed.item = args[++i];
        break;
      case '--help': case '-h':
        printUsage();
        process.exit(0);
      default:
        console.error(`  Unknown: ${args[i]}`);
        printUsage();
        process.exit(1);
    }
  }
  return parsed;
}

function printUsage() {
  console.log(`
  bazar sync

  Usage: node sync.mjs [operation] [options]

  Operations:
    (default)                         Sync bazar -> current project
    --push                            Push changed items -> bazar (with confirmation)
    --push --category <cat>           Push all changed items in a category
    --push --category <cat> --item <name>  Push a single changed item
    --push -y                         Push all changed items without confirmation
    --push --prune                    Push AND delete bazar files absent locally (destructive mirror; for intentional deletes/renames)
    --push --category <cat> --item <name> --force  Deliberately overwrite a moved bazar item
    --diff                            Show sync status
    --list                            List projects, profiles, items, and variants
    --add <cat> <name> [deploy-path]  Add item to current project
    --remove <cat> <name>             Remove item from current project
    --init [--profile <name>]         Add project using a profile
    --init [--from <path>]            Add project copying another's config
    --seed [--name <slug>]            Import project into bazar (initial setup)
    --link                            Register this bazar's local path on this device (~/.claude/bazar-paths.json)
    --unlink                          Remove this bazar's path entry from this device

  Options:
    --project <path>    Target specific project (default: cwd)
    --all               Sync all mapped projects
    --category <cat>    Filter push by category (skills, agents, commands, hooks, rules)
    --item <name>       Filter push by item name (requires --category)
    --yes, -y           Skip confirmation prompt
    --prune, --mirror   Let push delete bazar files that are absent on this device
                        (default push is additive and never deletes; it warns instead)
    --force             Bypass the item hash precondition for a deliberate rollback
                        (requires --category and --item)
    --profile <name>    Use a named profile (with --init)
    --from <path>       Copy config from another project (with --init)
    --name <slug>       Slug for claude-md/settings/mcp (with --seed)

  Ignore patterns:
    Configure in map.json "ignore" key to exclude runtime artifacts from
    sync, diff, and push. Keyed by item slug, array of patterns per item.

  Examples:
    node sync.mjs --push --category skills --item growth-kit
    node sync.mjs --push --category skills
    node sync.mjs --push -y
    node sync.mjs --init --profile dev
    node sync.mjs --add skills payment-processing
    node sync.mjs --add files justfile--claude-fast justfile
    node sync.mjs --remove files justfile--claude-fast
  `);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const projectRoot = args.project ? resolve(args.project) : process.cwd();
  let pushPullFailed = false;

  console.log(`\n  bazar sync`);
  console.log(`  bazar: ${norm(BAZAR)}`);

  // Pull latest before operations that read from bazar
  if (['sync', 'diff', 'push'].includes(args.command)) {
    process.stdout.write('  pulling latest... ');
    const pulled = gitPull();
    pulled ? console.log('done') : console.log('skipped');
    pushPullFailed = args.command === 'push' && Boolean(getBazarRemote()) && !pulled;
  }

  const map = readMap();

  // Self-populate the per-device registry on every invocation. sync.mjs
  // knows its own __dirname, so any user who runs this script gets
  // auto-registered without thinking about it. Idempotent — writePathRegistry
  // is a no-op if the value is unchanged. Skipped for --link/--unlink, which
  // manage the registry explicitly and report what they did.
  if (!['link', 'unlink'].includes(args.command)) {
    const remote = getBazarRemote();
    if (remote) {
      try { writePathRegistry(remote, norm(BAZAR)); } catch {}
    }
  }

  switch (args.command) {
    case 'sync':
      if (args.all) {
        for (const [key, config] of Object.entries(map.projects)) {
          const paths = (config.paths || []).filter(p => existsSync(p));
          if (!paths.length) { console.log(`\n  -> ${key}: not present on this device, skipped`); continue; }
          for (const path of paths) {
            console.log(`\n  -> ${key} (${norm(path)})`);
            syncProject(resolve(path), map);
          }
        }
      } else {
        syncProject(projectRoot, map);
      }
      break;
    case 'push':
      if (pushPullFailed) {
        console.error('  REFUSED: git pull --ff-only failed; bazar freshness is unknown.');
        process.exitCode = 1;
        break;
      }
      await pushProject(projectRoot, args.category, args.item, args.yes, args.prune, args.force);
      break;
    case 'diff':
      diffProject(projectRoot);
      break;
    case 'list':
      listBazar(map);
      break;
    case 'add':
      addItem(projectRoot, args.category, args.item, map, args.deployPath);
      break;
    case 'remove':
      removeItemFromProject(projectRoot, args.category, args.item, map);
      break;
    case 'init':
      initProject(projectRoot, args.from, args.profile, map);
      break;
    case 'seed':
      seedProject(projectRoot, args.name, map);
      break;
    case 'link': {
      const remote = getBazarRemote();
      if (!remote) { console.error('  No git remote in bazar directory.'); process.exit(1); }
      const wrote = writePathRegistry(remote, norm(BAZAR));
      console.log(wrote ? `  Linked ${remote} -> ${norm(BAZAR)} for this device` : `  Already linked: ${remote} -> ${norm(BAZAR)}`);
      break;
    }
    case 'unlink': {
      const remote = getBazarRemote();
      if (!remote) { console.error('  No git remote in bazar directory.'); process.exit(1); }
      const removed = removePathRegistryEntry(remote);
      console.log(removed ? `  Unlinked ${remote} from this device` : `  No registry entry for ${remote}`);
      break;
    }
    default:
      printUsage();
  }

  console.log();
}

main();
