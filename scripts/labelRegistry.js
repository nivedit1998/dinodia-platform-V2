#!/usr/bin/env node
// Architecture: canonical label-registry validation/synchronization helper.
// labels/registry.json is the source; active runtime copies and device visual/
// capability consumers must agree before platform/AWS changes are delivered.
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Label registry sync/check helper (canonical lives in dinodia-platform).
 *
 * Usage (from dinodia-platform):
 *   node scripts/labelRegistry.js sync
 *   node scripts/labelRegistry.js check
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const archivedKioskRoot = path.join(root, '..', '..', 'Archive', 'dinodia-kiosk');
const canonicalPath = path.join(root, 'labels', 'registry.json');
const targets = [
  {
    name: 'platform',
    path: path.join(root, 'src', 'config', 'labelRegistry.json'),
    visualsPath: path.join(root, 'src', 'components', 'device', 'deviceVisuals.tsx'),
    capabilitiesPath: path.join(root, 'src', 'lib', 'deviceCapabilities.ts'),
    commandsHandlerPath: path.join(root, 'src', 'lib', 'deviceControl.ts'),
    capabilitiesSourcePath: path.join(root, 'src', 'lib', 'deviceCapabilities.ts'),
  },
  {
    name: 'kiosk',
    path: path.join(archivedKioskRoot, 'src', 'config', 'labelRegistry.json'),
    visualsPath: path.join(archivedKioskRoot, 'src', 'components', 'deviceVisuals.ts'),
    capabilitiesPath: null, // kiosk capabilities optional for parity check
    commandsHandlerPath: path.join(archivedKioskRoot, 'src', 'utils', 'haCommands.ts'),
    capabilitiesSourcePath: path.join(archivedKioskRoot, 'src', 'capabilities', 'deviceCapabilities.ts'),
  },
];

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return { raw, data: JSON.parse(raw) };
}

function ensureUnique(list, label) {
  const set = new Set();
  for (const item of list) {
    const key = item.toLowerCase();
    if (set.has(key)) throw new Error(`Duplicate ${label} entry: ${item}`);
    set.add(key);
  }
}

function validateRegistry(reg) {
  if (typeof reg.version !== 'number') throw new Error('registry.version must be a number');
  if (typeof reg.otherLabel !== 'string' || !reg.otherLabel.trim()) {
    throw new Error('registry.otherLabel must be a non-empty string');
  }
  if (!Array.isArray(reg.groups) || reg.groups.length === 0) {
    throw new Error('registry.groups must be a non-empty array');
  }
  reg.groups.forEach((g) => {
    if (typeof g !== 'string' || !g.trim()) throw new Error('registry.groups entries must be strings');
  });
  ensureUnique(reg.groups, 'group');

  if (!Array.isArray(reg.labelCategories) || reg.labelCategories.length === 0) {
    throw new Error('registry.labelCategories must be a non-empty array');
  }
  ensureUnique(reg.labelCategories, 'label category');
  if (!reg.labelCategories.includes(reg.otherLabel)) {
    throw new Error(`registry.labelCategories must include otherLabel (${reg.otherLabel})`);
  }

  if (typeof reg.synonyms !== 'object' || reg.synonyms === null) {
    throw new Error('registry.synonyms must be an object');
  }
  for (const [key, value] of Object.entries(reg.synonyms)) {
    if (key !== key.toLowerCase()) throw new Error(`registry.synonyms key must be lowercase: ${key}`);
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`registry.synonyms value must be a non-empty string for key ${key}`);
    }
    if (!reg.labelCategories.includes(value)) {
      throw new Error(`registry.synonyms value "${value}" not found in labelCategories`);
    }
  }

  if (typeof reg.visuals !== 'object' || reg.visuals === null) {
    throw new Error('registry.visuals must be an object');
  }
  for (const group of reg.groups) {
    const entry = reg.visuals[group];
    if (!entry) throw new Error(`registry.visuals missing entry for group "${group}"`);
    if (entry.mode !== 'custom' && entry.mode !== 'default') {
      throw new Error(`registry.visuals["${group}"].mode must be "custom" or "default"`);
    }
  }
}

function copyRegistry() {
  const { raw, data } = readJson(canonicalPath);
  validateRegistry(data);
  for (const target of targets) {
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    fs.writeFileSync(target.path, raw.trim() + '\n', 'utf8');
    console.log(`[sync] wrote ${target.path}`);
  }
}

function assertFileEqualsCanonical(targetPath, canonicalRaw) {
  const targetRaw = fs.readFileSync(targetPath, 'utf8');
  if (targetRaw.trim() !== canonicalRaw.trim()) {
    throw new Error(`Copy out of sync: ${targetPath}`);
  }
}

function fileHasLabelKey(filePath, label) {
  const contents = fs.readFileSync(filePath, 'utf8');
  const patterns = [
    new RegExp(`['"]${label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}['"]\\s*:`),
    new RegExp(`\\b${label.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b\\s*:`),
  ];
  return patterns.some((re) => re.test(contents));
}

function extractCommands(filePath) {
  const contents = fs.readFileSync(filePath, 'utf8');
  const cmds = new Set();
  const regex = /['"]([a-z0-9_-]+\/[a-z0-9_-]+)['"]/gi;
  let m;
  while ((m = regex.exec(contents))) cmds.add(m[1]);
  return Array.from(cmds);
}

function assertCommandsHandled(label, commandsSourcePath, handlerPath) {
  const commands = extractCommands(commandsSourcePath);
  const handlerContents = fs.readFileSync(handlerPath, 'utf8');
  for (const cmd of commands) {
    if (!handlerContents.includes(cmd)) {
      throw new Error(`[${label}] Command missing handler: ${cmd} (expected in ${handlerPath})`);
    }
  }
}

function runChecks() {
  const { raw: canonicalRaw, data: registry } = readJson(canonicalPath);
  validateRegistry(registry);

  for (const target of targets) {
    if (!fs.existsSync(target.path)) {
      throw new Error(`Missing registry copy: ${target.path}`);
    }
    assertFileEqualsCanonical(target.path, canonicalRaw);

    // Visuals coverage: only labels marked custom
    for (const group of registry.groups) {
      const mode = registry.visuals[group]?.mode;
      if (mode === 'custom' && target.visualsPath) {
        if (!fs.existsSync(target.visualsPath) || !fileHasLabelKey(target.visualsPath, group)) {
          throw new Error(`[${target.name}] visuals missing for "${group}" in ${target.visualsPath}`);
        }
      }
    }

    // Platform capabilities must cover all groups
    if (target.capabilitiesPath) {
      for (const group of registry.groups) {
        if (group === 'Remote') {
          continue;
        }
        if (!fileHasLabelKey(target.capabilitiesPath, group)) {
          throw new Error(`[${target.name}] capabilities missing for "${group}" in ${target.capabilitiesPath}`);
        }
      }
    }

    // Command routing completeness
    assertCommandsHandled(target.name, target.capabilitiesSourcePath, target.commandsHandlerPath);
  }

  console.log('label-registry:check passed');
}

function main() {
  const cmd = process.argv[2];
  if (cmd === 'sync') {
    copyRegistry();
    return;
  }
  if (cmd === 'check') {
    runChecks();
    return;
  }
  console.log('Usage: node scripts/labelRegistry.js [sync|check]');
  process.exit(1);
}

main();
