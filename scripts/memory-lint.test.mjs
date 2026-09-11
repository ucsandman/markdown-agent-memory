import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory-lint.mjs');

function git(dir, args) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function mkRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlint-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function commit(dir, msg) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg]);
}

function baseConfig() {
  return {
    index: 'MEMORY.md',
    tags: ['stated', 'observed', 'inferred', 'suggested'],
    tiers: {
      rom: { files: { 'MEMORY.md': { maxChars: 15000 } }, totalMaxChars: 60000 },
      ram: { dirs: ['memory/context'], patterns: ['^memory/\\d{4}-\\d{2}-\\d{2}.*\\.md$'], maxChars: 30000 },
      disk: { dirs: ['memory/people', 'memory/projects', 'memory/decisions'] },
      tape: { dirs: ['memory/archive'] },
    },
  };
}

function writeConfig(dir, cfg, rel = 'memory-lint.json') {
  writeFile(dir, rel, JSON.stringify(cfg, null, 2));
}

function runCli(dir, args = []) {
  return spawnSync(process.execPath, [CLI, '--root', dir, ...args], { encoding: 'utf8' });
}

// --- rom-caps ---

test('rom-caps: under cap passes', () => {
  const dir = mkRepo();
  writeFile(dir, 'MEMORY.md', 'a short index file');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  const res = runCli(dir, ['--no-diff']);
  assert.match(res.stdout, /PASS rom-caps/);
  assert.equal(res.status, 0);
});

test('rom-caps: over maxChars fails', () => {
  const dir = mkRepo();
  const cfg = baseConfig();
  cfg.tiers.rom.files['MEMORY.md'].maxChars = 10;
  writeFile(dir, 'MEMORY.md', 'x'.repeat(50));
  writeConfig(dir, cfg);
  commit(dir, 'baseline');
  const res = runCli(dir, ['--no-diff']);
  assert.match(res.stdout, /FAIL rom-caps/);
  assert.equal(res.status, 1);
});

test('rom-caps: over maxLines fails', () => {
  const dir = mkRepo();
  const cfg = baseConfig();
  cfg.tiers.rom.files['MEMORY.md'].maxLines = 2;
  writeFile(dir, 'MEMORY.md', 'line1\nline2\nline3\nline4\n');
  writeConfig(dir, cfg);
  commit(dir, 'baseline');
  const res = runCli(dir, ['--no-diff']);
  assert.match(res.stdout, /FAIL rom-caps/);
  assert.equal(res.status, 1);
});

test('rom-caps: totalMaxChars exceeded fails', () => {
  const dir = mkRepo();
  const cfg = baseConfig();
  cfg.tiers.rom.files['MEMORY.md'].maxChars = 1000;
  cfg.tiers.rom.totalMaxChars = 10;
  writeFile(dir, 'MEMORY.md', 'x'.repeat(50));
  writeConfig(dir, cfg);
  commit(dir, 'baseline');
  const res = runCli(dir, ['--no-diff']);
  assert.match(res.stdout, /FAIL rom-caps/);
  assert.equal(res.status, 1);
});

test('rom-caps: char count uses string length not bytes', () => {
  const dir = mkRepo();
  const cfg = baseConfig();
  cfg.tiers.rom.files['MEMORY.md'].maxChars = 10;
  writeFile(dir, 'MEMORY.md', 'é'.length ? 'é'.repeat(10) : 'é'.repeat(10));
  writeConfig(dir, cfg);
  commit(dir, 'baseline');
  const res = runCli(dir, ['--no-diff']);
  assert.match(res.stdout, /PASS rom-caps/);
  assert.equal(res.status, 0);
});

// --- ram-caps ---

test('ram-caps: touched over-cap daily note fails', () => {
  const dir = mkRepo();
  const cfg = baseConfig();
  cfg.tiers.ram.maxChars = 20;
  writeFile(dir, 'MEMORY.md', 'index');
  writeConfig(dir, cfg);
  commit(dir, 'baseline');
  writeFile(dir, 'memory/2026-09-11.md', 'x'.repeat(50));
  const res = runCli(dir);
  assert.match(res.stdout, /FAIL ram-caps/);
  assert.equal(res.status, 1);
});

test('ram-caps: untouched over-cap file only WARNs and exit 0', () => {
  const dir = mkRepo();
  const cfg = baseConfig();
  cfg.tiers.ram.maxChars = 20;
  writeFile(dir, 'MEMORY.md', 'index');
  writeFile(dir, 'memory/2026-09-11.md', 'x'.repeat(50));
  writeConfig(dir, cfg);
  commit(dir, 'baseline');
  // no changes since baseline
  const res = runCli(dir);
  assert.match(res.stdout, /WARN ram-caps/);
  assert.equal(res.status, 0);
});

// --- disk-provenance ---

test('disk-provenance: added tagged line passes', () => {
  const dir = mkRepo();
  writeFile(dir, 'MEMORY.md', 'index');
  writeFile(dir, 'memory/people/wes.md', '# Wes\n');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  fs.appendFileSync(path.join(dir, 'memory/people/wes.md'), '- [observed] foo (2026-09-11)\n');
  const res = runCli(dir);
  assert.match(res.stdout, /PASS disk-provenance/);
  assert.equal(res.status, 0);
});

test('disk-provenance: added untagged line fails with correct line number', () => {
  const dir = mkRepo();
  writeFile(dir, 'MEMORY.md', 'index');
  writeFile(dir, 'memory/people/wes.md', '# Wes\nline2\n');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  fs.appendFileSync(path.join(dir, 'memory/people/wes.md'), '- foo\n');
  const res = runCli(dir);
  assert.match(res.stdout, /FAIL disk-provenance/);
  assert.match(res.stdout, /memory\/people\/wes\.md:3/);
  assert.equal(res.status, 1);
});

test('disk-provenance: added struck superseding line passes', () => {
  const dir = mkRepo();
  writeFile(dir, 'MEMORY.md', 'index');
  writeFile(dir, 'memory/people/wes.md', '# Wes\n');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  fs.appendFileSync(path.join(dir, 'memory/people/wes.md'), '- ~~[stated] old~~ superseded 2026-09-11\n');
  const res = runCli(dir);
  assert.match(res.stdout, /PASS disk-provenance/);
  assert.equal(res.status, 0);
});

test('disk-provenance: staged mode only sees staged lines', () => {
  const dir = mkRepo();
  writeFile(dir, 'MEMORY.md', 'index');
  writeFile(dir, 'memory/people/wes.md', '# Wes\n');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  fs.appendFileSync(path.join(dir, 'memory/people/wes.md'), '- [observed] staged fact (2026-09-11)\n');
  git(dir, ['add', '-A']);
  fs.appendFileSync(path.join(dir, 'memory/people/wes.md'), '- unstaged untagged fact\n');
  const res = runCli(dir, ['--staged']);
  assert.match(res.stdout, /PASS disk-provenance/);
  assert.equal(res.status, 0);
});

test('disk-provenance: untracked new disk file with untagged bullet fails in default mode', () => {
  const dir = mkRepo();
  writeFile(dir, 'MEMORY.md', 'index');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  writeFile(dir, 'memory/people/newperson.md', '# New\n- untagged fact\n');
  const res = runCli(dir);
  assert.match(res.stdout, /FAIL disk-provenance/);
  assert.equal(res.status, 1);
});

// --- disk-history ---

test('disk-history: deleting a struck line fails', () => {
  const dir = mkRepo();
  writeFile(dir, 'MEMORY.md', 'index');
  writeFile(dir, 'memory/people/wes.md', '# Wes\n- ~~[stated] old~~ superseded 2026-09-10\n- [observed] keep (2026-09-10)\n');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  writeFile(dir, 'memory/people/wes.md', '# Wes\n- [observed] keep (2026-09-10)\n');
  const res = runCli(dir);
  assert.match(res.stdout, /FAIL disk-history/);
  assert.equal(res.status, 1);
});

test('disk-history: moving a struck line to another disk file passes', () => {
  const dir = mkRepo();
  const struck = '- ~~[stated] old~~ superseded 2026-09-10';
  writeFile(dir, 'MEMORY.md', 'index');
  writeFile(dir, 'memory/people/a.md', `# A\n${struck}\n`);
  writeFile(dir, 'memory/people/b.md', '# B\n');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  writeFile(dir, 'memory/people/a.md', '# A\n');
  writeFile(dir, 'memory/people/b.md', `# B\n${struck}\n`);
  const res = runCli(dir);
  assert.match(res.stdout, /PASS disk-history/);
  assert.equal(res.status, 0);
});

test('disk-history: editing an untagged plain line to a struck line passes', () => {
  const dir = mkRepo();
  writeFile(dir, 'MEMORY.md', 'index');
  writeFile(dir, 'memory/people/wes.md', '# Wes\n- something\n');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  writeFile(dir, 'memory/people/wes.md', '# Wes\n- ~~something~~ replaced 2026-09-11\n');
  const res = runCli(dir);
  assert.match(res.stdout, /PASS disk-history/);
  assert.equal(res.status, 0);
});

// --- tape-frozen ---

test('tape-frozen: adding a new archive file passes', () => {
  const dir = mkRepo();
  writeFile(dir, 'MEMORY.md', 'index');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  writeFile(dir, 'memory/archive/old-note.md', 'frozen content\n');
  const res = runCli(dir);
  assert.match(res.stdout, /PASS tape-frozen/);
  assert.equal(res.status, 0);
});

test('tape-frozen: git mv a disk file into archive unchanged passes', () => {
  const dir = mkRepo();
  writeFile(dir, 'MEMORY.md', 'index');
  writeFile(dir, 'memory/people/old.md', '# Old\n');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  git(dir, ['mv', 'memory/people/old.md', 'memory/archive/old.md']);
  const res = runCli(dir);
  assert.match(res.stdout, /PASS tape-frozen/);
  assert.equal(res.status, 0);
});

test('tape-frozen: modifying an archived file fails', () => {
  const dir = mkRepo();
  writeFile(dir, 'MEMORY.md', 'index');
  writeFile(dir, 'memory/archive/frozen.md', 'original\n');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  writeFile(dir, 'memory/archive/frozen.md', 'changed\n');
  const res = runCli(dir);
  assert.match(res.stdout, /FAIL tape-frozen/);
  assert.equal(res.status, 1);
});

test('tape-frozen: deleting an archived file fails', () => {
  const dir = mkRepo();
  writeFile(dir, 'MEMORY.md', 'index');
  writeFile(dir, 'memory/archive/frozen2.md', 'original\n');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  fs.unlinkSync(path.join(dir, 'memory/archive/frozen2.md'));
  const res = runCli(dir);
  assert.match(res.stdout, /FAIL tape-frozen/);
  assert.equal(res.status, 1);
});

// --- index-links ---

test('index-links: existing target passes, missing target fails, YYYY placeholder ignored', () => {
  const dir = mkRepo();
  writeFile(dir, 'memory/people/a.md', '# A\n');
  writeFile(
    dir,
    'MEMORY.md',
    'See [people](memory/people/a.md) and [gone](memory/people/missing.md).\nDaily notes: memory/YYYY-MM-DD.md\n'
  );
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  const res = runCli(dir, ['--no-diff']);
  assert.match(res.stdout, /FAIL index-links/);
  assert.match(res.stdout, /missing\.md/);
  assert.doesNotMatch(res.stdout, /YYYY-MM-DD\.md.*not found/);
  assert.equal(res.status, 1);
});

test('index-links: table cell resolved relative to root', () => {
  const dir = mkRepo();
  writeFile(dir, 'people/wes.md', '# Wes\n');
  writeFile(dir, 'MEMORY.md', '| name | file |\n| --- | --- |\n| wes | people/wes.md |\n');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  const res = runCli(dir, ['--no-diff']);
  assert.match(res.stdout, /PASS index-links/);
  assert.equal(res.status, 0);
});

// --- general behavior ---

test('--no-diff reports the pure-diff checks as SKIP and still runs rom-caps and index-links', () => {
  const dir = mkRepo();
  writeFile(dir, 'MEMORY.md', 'index');
  writeFile(dir, 'memory/people/wes.md', '# Wes\n');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  fs.appendFileSync(path.join(dir, 'memory/people/wes.md'), '- untagged\n');
  const res = runCli(dir, ['--no-diff']);
  assert.match(res.stdout, /SKIP disk-provenance/);
  assert.match(res.stdout, /SKIP disk-history/);
  assert.match(res.stdout, /SKIP tape-frozen/);
  assert.match(res.stdout, /(PASS|FAIL) rom-caps/);
  assert.match(res.stdout, /(PASS|FAIL) index-links/);
});

test('--json output parses and has result FAIL when a check fails', () => {
  const dir = mkRepo();
  writeFile(dir, 'MEMORY.md', 'index');
  writeFile(dir, 'memory/people/wes.md', '# Wes\n');
  writeConfig(dir, baseConfig());
  commit(dir, 'baseline');
  fs.appendFileSync(path.join(dir, 'memory/people/wes.md'), '- untagged\n');
  const res = runCli(dir, ['--json']);
  const out = JSON.parse(res.stdout);
  assert.equal(out.result, 'FAIL');
  assert.ok(Array.isArray(out.checks));
  assert.ok(out.checks.some((c) => c.name === 'disk-provenance' && c.status === 'FAIL'));
  assert.equal(res.status, 1);
});

test('missing config exits 2', () => {
  const dir = mkRepo();
  writeFile(dir, 'MEMORY.md', 'index');
  commit(dir, 'baseline');
  const res = runCli(dir);
  assert.equal(res.status, 2);
});

test('root as a subdirectory of the git repo resolves disk paths relative to root', () => {
  const repo = mkRepo();
  writeFile(repo, 'store/MEMORY.md', 'index');
  writeFile(repo, 'store/memory/people/wes.md', '# Wes\n');
  writeConfig(repo, baseConfig(), 'store/memory-lint.json');
  commit(repo, 'baseline');
  const storeDir = path.join(repo, 'store');
  fs.appendFileSync(path.join(storeDir, 'memory/people/wes.md'), '- untagged\n');
  const res = runCli(storeDir);
  assert.match(res.stdout, /FAIL disk-provenance/);
  assert.match(res.stdout, /memory\/people\/wes\.md:2/);
  assert.equal(res.status, 1);
});

// --- regressions found by the first real run (2026-09-11) ---

test('a diff over 1 MB is read, not skipped', () => {
  const dir = mkRepo();
  writeConfig(dir, baseConfig());
  writeFile(dir, 'MEMORY.md', 'index');
  commit(dir, 'baseline');
  const big = Array.from({ length: 40000 }, (_, i) => `- [observed] fact number ${i} padded with enough text to grow the diff`).join('\n') + '\n';
  writeFile(dir, 'memory/people/big.md', big);
  git(dir, ['add', '-A']);
  const res = runCli(dir, ['--staged']);
  assert.match(res.stdout, /PASS disk-provenance\s+40000 added fact lines/);
  assert.equal(res.status, 0);
});

test('a git diff failure fails the diff checks instead of skipping them', () => {
  const dir = mkRepo();
  writeConfig(dir, baseConfig());
  writeFile(dir, 'MEMORY.md', 'index');
  commit(dir, 'baseline');
  const res = runCli(dir, ['--base', 'no-such-ref']);
  assert.match(res.stdout, /FAIL disk-provenance\s+nothing checked, git diff failed/);
  assert.equal(res.status, 1);
});

test('a removed struck line starting with -- inside a hunk is still checked', () => {
  const dir = mkRepo();
  writeConfig(dir, baseConfig());
  writeFile(dir, 'MEMORY.md', 'index');
  writeFile(dir, 'memory/people/a.md', '# A\n\n-- ~~[stated] old dash-led line~~ superseded 2026-09-01\n- [stated] kept\n');
  commit(dir, 'baseline');
  writeFile(dir, 'memory/people/a.md', '# A\n\n- [stated] kept\n');
  const res = runCli(dir);
  assert.match(res.stdout, /FAIL disk-history/);
  assert.equal(res.status, 1);
});

test('index-links: a bare filename in plain prose is a word, in backticks it is a path', () => {
  const dir = mkRepo();
  writeConfig(dir, baseConfig());
  writeFile(dir, 'MEMORY.md', '# Index\n\n| decisions | triggers: CLAUDE.md symlink, AGENTS.md parity |\n');
  commit(dir, 'baseline');
  const prose = runCli(dir, ['--no-diff']);
  assert.match(prose.stdout, /PASS index-links\s+0 links checked/);
  writeFile(dir, 'MEMORY.md', '# Index\n\nThe catalog is `TOOLS.md`.\n');
  const ticked = runCli(dir, ['--no-diff']);
  assert.match(ticked.stdout, /FAIL index-links/);
  assert.equal(ticked.status, 1);
});
