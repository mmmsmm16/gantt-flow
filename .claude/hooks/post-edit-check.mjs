#!/usr/bin/env node
// PostToolUse hook for gantt-flow.
// After an Edit/Write to a TS/TSX file, type-check the affected workspace.
// If the change is under packages/core/src/sync/ (the sync engine — the #1 risk),
// also run the core test suite. Exit 2 surfaces failures back to Claude to fix.
//
// Reads the hook payload JSON from stdin:
//   { tool_name, tool_input: { file_path }, tool_response: { filePath? } }
//
// Tune/disable: edit .claude/settings.json (hooks.PostToolUse) or run /hooks.
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readStdin() {
  return new Promise((res) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => res(data));
    // Don't hang if no stdin is piped.
    setTimeout(() => res(data), 3000);
  });
}

const raw = await readStdin();
let payload = {};
try {
  // Strip a leading BOM / surrounding whitespace some Windows shells prepend on stdin.
  const cleaned = raw.replace(/^﻿/, '').trim();
  payload = JSON.parse(cleaned || '{}');
} catch {
  process.exit(0); // unparseable stdin → do nothing (fail open; never block edits on a hook glitch)
}

const filePath = payload?.tool_input?.file_path ?? payload?.tool_response?.filePath ?? '';
const norm = String(filePath).replace(/\\/g, '/');

// Only TS/TSX edits inside a workspace are interesting.
if (!/\.(ts|tsx)$/.test(norm)) process.exit(0);

let workspace = null;
if (norm.includes('/packages/core/')) workspace = '@gantt-flow/core';
else if (norm.includes('/apps/desktop/')) workspace = '@gantt-flow/desktop';
if (!workspace) process.exit(0);

const problems = [];
function run(cmd, label) {
  try {
    execSync(cmd, { cwd: projectRoot, stdio: 'pipe', encoding: 'utf8' });
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || String(e.message ?? e);
    problems.push(`### ${label} failed\n${out.slice(0, 4000)}`);
  }
}

run(`npm run typecheck -w ${workspace} --silent`, `typecheck (${workspace})`);

// Sync engine touched → run the core suite (golden + fast-check property tests).
if (norm.includes('/packages/core/src/sync/')) {
  run('npm test -w @gantt-flow/core --silent', 'core tests');
}

if (problems.length) {
  console.error(
    `Post-edit check failed after editing ${filePath}:\n\n${problems.join('\n\n')}\n\n` +
      `Fix the above before continuing (this hook ran from .claude/hooks/post-edit-check.mjs).`,
  );
  process.exit(2);
}
process.exit(0);
