#!/usr/bin/env node
// memory-lint: machine checks for a markdown agent memory store.
//
// The store has four tiers, by hardware analogy:
//   rom  - boot-loaded index/instruction files (MEMORY.md). Read-mostly,
//          hard char/line caps because harnesses truncate large boot files.
//   ram  - working memory (context dir, daily notes). Rewritten freely but
//          capacity-bounded; a touched file over cap must be trimmed.
//   disk - durable facts (people/, projects/, decisions/). Every new fact
//          line carries a provenance tag; supersession is a strikethrough
//          edit, so struck lines are history and must never just vanish.
//   tape - archive dirs. Frozen: files may be added (or renamed unchanged),
//          never modified or deleted.
// Each tier gets one check below, plus rom-caps and an index-links check
// that verifies MEMORY.md only points at files that actually exist.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const VERSION = '1.0.0';

function usageError(msg) {
  process.stderr.write(`memory-lint: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { root: process.cwd(), config: null, mode: 'default', base: null, json: false, quiet: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version') { opts.version = true; }
    else if (a === '--root') { opts.root = argv[++i]; if (opts.root === undefined) usageError('--root needs a value'); }
    else if (a === '--config') { opts.config = argv[++i]; if (opts.config === undefined) usageError('--config needs a value'); }
    else if (a === '--staged') { opts.mode = 'staged'; }
    else if (a === '--base') { opts.mode = 'base'; opts.base = argv[++i]; if (opts.base === undefined) usageError('--base needs a value'); }
    else if (a === '--no-diff') { opts.mode = 'no-diff'; }
    else if (a === '--json') { opts.json = true; }
    else if (a === '--quiet') { opts.quiet = true; }
    else usageError(`unknown argument: ${a}`);
  }
  return opts;
}

function loadConfig(root, configPath) {
  const abs = path.resolve(root, configPath || 'memory-lint.json');
  if (!fs.existsSync(abs)) usageError(`config file not found: ${abs}`);
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); } catch (e) { usageError(`cannot read config: ${e.message}`); }
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { usageError(`config is not valid JSON: ${e.message}`); }
  cfg.tags = cfg.tags || [];
  cfg.tiers = cfg.tiers || {};
  return cfg;
}

function dequote(s) {
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { return s; }
  }
  return s;
}

function runGit(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

function isRepo(root) {
  const r = runGit(['rev-parse', '--is-inside-work-tree'], root);
  return r.status === 0 && r.stdout.trim() === 'true';
}

function headExists(root) {
  const r = runGit(['rev-parse', '--verify', 'HEAD'], root);
  return r.status === 0;
}

function parseNameStatus(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split('\t');
    const status = parts[0];
    let oldPath, newPath;
    if (status[0] === 'R' || status[0] === 'C') {
      oldPath = dequote(parts[1]);
      newPath = dequote(parts[2]);
    } else if (status[0] === 'D') {
      oldPath = dequote(parts[1]);
      newPath = null;
    } else {
      oldPath = newPath = dequote(parts[1]);
    }
    const similarity = status.length > 1 ? parseInt(status.slice(1), 10) : null;
    out.push({ status, oldPath, newPath, similarity });
  }
  return out;
}

function parseHunkSections(text) {
  const lines = text.split(/\r?\n/);
  const sections = [];
  let current = null;
  let oldLine = 0, newLine = 0;
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = { addedLines: [], removedLines: [] };
      sections.push(current);
      inHunk = false;
      continue;
    }
    if (!current) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[3], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // file headers (+++ / ---) come before the first hunk
    if (line.startsWith('+')) {
      current.addedLines.push({ line: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith('-')) {
      current.removedLines.push({ line: oldLine, text: line.slice(1) });
      oldLine++;
    } else if (line.startsWith(' ')) {
      oldLine++; newLine++;
    }
  }
  return sections;
}

function getDiff(root, opts) {
  const mode = opts.mode;
  if (mode === 'no-diff') {
    return { skipped: '--no-diff requested', mode: 'no-diff', entries: [], added: 0, removed: 0, files: 0 };
  }
  if (!isRepo(root)) {
    return { skipped: 'root is not inside a git repository', mode, entries: [], added: 0, removed: 0, files: 0 };
  }
  if (!headExists(root)) {
    return { skipped: 'HEAD does not exist', mode, entries: [], added: 0, removed: 0, files: 0 };
  }
  const revArgs = mode === 'staged' ? ['--cached'] : mode === 'base' ? [opts.base] : ['HEAD'];
  const fullArgs = ['-c', 'core.quotepath=false', 'diff', ...revArgs, '-M', '--unified=0', '--no-color', '--no-ext-diff', '--relative'];
  const nameArgs = ['-c', 'core.quotepath=false', 'diff', ...revArgs, '--name-status', '-M', '--relative'];
  const full = runGit(fullArgs, root);
  const name = runGit(nameArgs, root);
  if (full.status !== 0 || name.status !== 0) {
    // A diff that cannot be read fails the diff checks; a commit hook must never pass on nothing.
    const bad = full.status !== 0 ? full : name;
    const stderr = (bad.stderr || '').split(/\r?\n/).filter((l) => l && !l.includes('LF will be replaced')).join(' ');
    const reason = (bad.error ? bad.error.message : stderr) || `exit ${bad.status}`;
    return { skipped: null, failed: `git diff failed: ${reason.slice(0, 300)}`, mode, entries: [], added: 0, removed: 0, files: 0 };
  }
  const nameStatus = parseNameStatus(name.stdout);
  const sections = parseHunkSections(full.stdout);
  const entries = nameStatus.map((ns, i) => ({
    ...ns,
    addedLines: sections[i] ? sections[i].addedLines : [],
    removedLines: sections[i] ? sections[i].removedLines : [],
  }));

  if (mode === 'default') {
    const untracked = runGit(['ls-files', '--others', '--exclude-standard'], root);
    if (untracked.status === 0) {
      for (const rel of untracked.stdout.split(/\r?\n/)) {
        if (!rel) continue;
        const p = dequote(rel);
        const abs = path.resolve(root, p);
        let content;
        try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
        let lines = content.split(/\r?\n/);
        if (lines.length && lines[lines.length - 1] === '' && content.endsWith('\n')) lines.pop();
        const addedLines = lines.map((text, idx) => ({ line: idx + 1, text }));
        entries.push({ status: 'A', oldPath: null, newPath: p, similarity: null, addedLines, removedLines: [] });
      }
    }
  }

  const modeLabel = mode === 'base' ? `base:${opts.base}` : mode;
  const added = entries.reduce((n, e) => n + e.addedLines.length, 0);
  const removed = entries.reduce((n, e) => n + e.removedLines.length, 0);
  return { skipped: null, mode: modeLabel, entries, added, removed, files: entries.length };
}

function inDir(relPath, dirs) {
  return (dirs || []).some((d) => relPath === d || relPath.startsWith(d + '/'));
}

function isRamFile(relPath, tier) {
  if (!tier) return false;
  if (inDir(relPath, tier.dirs)) return true;
  for (const pat of tier.patterns || []) {
    if (new RegExp(pat).test(relPath)) return true;
  }
  return false;
}

function countLines(content) {
  if (content.length === 0) return 0;
  const parts = content.split(/\r?\n/);
  if (content.endsWith('\n')) parts.pop();
  return parts.length;
}

function fmt(n) {
  return n.toLocaleString('en-US');
}

function trim160(s) {
  return s.length > 160 ? s.slice(0, 160) + '...' : s;
}

function walkMarkdown(root) {
  const out = [];
  function walk(dir) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile() && ent.name.endsWith('.md')) out.push(abs);
    }
  }
  walk(root);
  return out.map((abs) => path.relative(root, abs).split(path.sep).join('/'));
}

// --- checks ---

function checkRomCaps(config, root) {
  const tier = config.tiers.rom;
  if (!tier || (!tier.files && !tier.totalMaxChars)) {
    return { name: 'rom-caps', status: 'SKIP', summary: 'no rom tier configured', details: [] };
  }
  const files = tier.files || {};
  const details = [];
  const warnDetails = [];
  let totalChars = 0;
  let existingCount = 0;
  for (const [relPath, limits] of Object.entries(files)) {
    const abs = path.resolve(root, relPath);
    if (!fs.existsSync(abs)) {
      warnDetails.push({ path: relPath, line: null, reason: 'rom file missing' });
      continue;
    }
    const content = fs.readFileSync(abs, 'utf8');
    const chars = content.length;
    const lines = countLines(content);
    existingCount++;
    totalChars += chars;
    if (limits.maxChars && chars > limits.maxChars) {
      details.push({ path: relPath, line: null, reason: `${fmt(chars)} chars > max ${fmt(limits.maxChars)}` });
    }
    if (limits.maxLines && lines > limits.maxLines) {
      details.push({ path: relPath, line: null, reason: `${fmt(lines)} lines > max ${fmt(limits.maxLines)}` });
    }
  }
  if (tier.totalMaxChars && totalChars > tier.totalMaxChars) {
    details.push({ path: '<total>', line: null, reason: `total ${fmt(totalChars)} chars > max ${fmt(tier.totalMaxChars)}` });
  }
  const summary = `${existingCount} files, ${fmt(totalChars)}${tier.totalMaxChars ? ' / ' + fmt(tier.totalMaxChars) : ''} total chars`;
  let status = 'PASS';
  if (details.length) status = 'FAIL';
  else if (warnDetails.length) status = 'WARN';
  return { name: 'rom-caps', status, summary, details: details.length ? details : warnDetails };
}

function checkRamCaps(config, root, diff) {
  const tier = config.tiers.ram;
  if (!tier) return { name: 'ram-caps', status: 'SKIP', summary: 'no ram tier configured', details: [] };
  const mdFiles = walkMarkdown(root).filter((rel) => isRamFile(rel, tier));
  const touched = new Set();
  if (!diff.skipped && !diff.failed) {
    for (const e of diff.entries) {
      if (e.status !== 'D' && e.newPath && e.newPath.endsWith('.md') && isRamFile(e.newPath, tier)) touched.add(e.newPath);
    }
  }
  const failDetails = [];
  const warnDetails = [];
  let overCapCount = 0;
  for (const rel of mdFiles) {
    const abs = path.resolve(root, rel);
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const chars = content.length;
    if (tier.maxChars && chars > tier.maxChars) {
      overCapCount++;
      const reason = `${fmt(chars)} chars > max ${fmt(tier.maxChars)}`;
      if (!diff.skipped && !diff.failed && touched.has(rel)) failDetails.push({ path: rel, line: null, reason });
      else warnDetails.push({ path: rel, line: null, reason });
    }
  }
  const summary = `${mdFiles.length} ram files scanned, ${overCapCount} over cap (${failDetails.length} touched, ${warnDetails.length} untouched)`;
  let status = 'PASS';
  if (failDetails.length) status = 'FAIL';
  else if (warnDetails.length) status = 'WARN';
  return { name: 'ram-caps', status, summary, details: failDetails.length ? failDetails : warnDetails };
}

const FACT_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
const STRIKE_RE = /~~[\s\S]*~~/;

function tagRegex(tags) {
  return new RegExp(`\\[(?:${tags.join('|')})\\]`);
}

function checkDiskProvenance(config, root, diff) {
  const dirs = config.tiers.disk && config.tiers.disk.dirs;
  if (!dirs) return { name: 'disk-provenance', status: 'SKIP', summary: 'no disk tier configured', details: [] };
  if (diff.failed) return { name: 'disk-provenance', status: 'FAIL', summary: 'nothing checked, git diff failed', details: [{ path: '<git>', line: null, reason: diff.failed }] };
  if (diff.skipped) return { name: 'disk-provenance', status: 'SKIP', summary: `skipped: ${diff.skipped}`, details: [] };
  const tagRe = tagRegex(config.tags.length ? config.tags : ['stated', 'observed', 'inferred', 'suggested']);
  const details = [];
  let factCount = 0;
  const filesWithFacts = new Set();
  for (const e of diff.entries) {
    if (!e.newPath || !e.newPath.endsWith('.md') || !inDir(e.newPath, dirs)) continue;
    for (const { line, text } of e.addedLines) {
      if (!FACT_LINE_RE.test(text)) continue;
      factCount++;
      filesWithFacts.add(e.newPath);
      if (!tagRe.test(text) && !STRIKE_RE.test(text)) {
        details.push({ path: e.newPath, line, reason: `fact line missing provenance tag: "${trim160(text.trim())}"` });
      }
    }
  }
  const summary = `${factCount} added fact lines in ${filesWithFacts.size} files${details.length ? '' : ', all tagged'}`;
  return { name: 'disk-provenance', status: details.length ? 'FAIL' : 'PASS', summary, details };
}

function checkDiskHistory(config, root, diff) {
  const dirs = config.tiers.disk && config.tiers.disk.dirs;
  if (!dirs) return { name: 'disk-history', status: 'SKIP', summary: 'no disk tier configured', details: [] };
  if (diff.failed) return { name: 'disk-history', status: 'FAIL', summary: 'nothing checked, git diff failed', details: [{ path: '<git>', line: null, reason: diff.failed }] };
  if (diff.skipped) return { name: 'disk-history', status: 'SKIP', summary: `skipped: ${diff.skipped}`, details: [] };
  const addedTrimmed = new Set();
  for (const e of diff.entries) {
    for (const { text } of e.addedLines) addedTrimmed.add(text.trim());
  }
  const details = [];
  let checkedCount = 0;
  for (const e of diff.entries) {
    const p = e.oldPath || e.newPath;
    if (!p || !p.endsWith('.md') || !inDir(p, dirs)) continue;
    for (const { line, text } of e.removedLines) {
      if (!STRIKE_RE.test(text)) continue;
      checkedCount++;
      if (!addedTrimmed.has(text.trim())) {
        details.push({ path: p, line, reason: `struck line removed with no matching addition: "${trim160(text.trim())}"` });
      }
    }
  }
  const summary = `${checkedCount} removed struck lines checked, ${details.length} lost`;
  return { name: 'disk-history', status: details.length ? 'FAIL' : 'PASS', summary, details };
}

function checkTapeFrozen(config, root, diff) {
  const dirs = config.tiers.tape && config.tiers.tape.dirs;
  if (!dirs) return { name: 'tape-frozen', status: 'SKIP', summary: 'no tape tier configured', details: [] };
  if (diff.failed) return { name: 'tape-frozen', status: 'FAIL', summary: 'nothing checked, git diff failed', details: [{ path: '<git>', line: null, reason: diff.failed }] };
  if (diff.skipped) return { name: 'tape-frozen', status: 'SKIP', summary: `skipped: ${diff.skipped}`, details: [] };
  const details = [];
  let checkedCount = 0;
  for (const e of diff.entries) {
    const oldInTape = e.oldPath && inDir(e.oldPath, dirs);
    const newInTape = e.newPath && inDir(e.newPath, dirs);
    if (!oldInTape && !newInTape) continue;
    checkedCount++;
    const letter = e.status[0];
    if (letter === 'A') continue;
    if (letter === 'R' || letter === 'C') {
      if (e.similarity === 100 && newInTape) continue;
      const p = newInTape ? e.newPath : e.oldPath;
      details.push({ path: p, line: null, reason: `rename/copy with content change touches frozen tape dir (similarity ${e.similarity})` });
      continue;
    }
    if (letter === 'M') details.push({ path: e.newPath, line: null, reason: 'modified file in frozen tape dir' });
    else if (letter === 'D') details.push({ path: e.oldPath, line: null, reason: 'deleted file in frozen tape dir' });
    else if (letter === 'T') details.push({ path: e.newPath || e.oldPath, line: null, reason: 'type change in frozen tape dir' });
  }
  const summary = `${checkedCount} tape-path diff entries checked, ${details.length} violations`;
  return { name: 'tape-frozen', status: details.length ? 'FAIL' : 'PASS', summary, details };
}

const LINK_TOKEN_RE = /(?:^|[\s|`(\[])((?:[\w.-]+\/)*[\w.-]+(?:\.md|\/))(?=$|[\s|`),:;\]])/g;

function checkIndexLinks(config, root) {
  if (!config.index) return { name: 'index-links', status: 'SKIP', summary: 'no index file configured', details: [] };
  const abs = path.resolve(root, config.index);
  if (!fs.existsSync(abs)) {
    return { name: 'index-links', status: 'WARN', summary: `index file not found: ${config.index}`, details: [] };
  }
  const content = fs.readFileSync(abs, 'utf8');
  const lines = content.split(/\r?\n/);
  const details = [];
  let checked = 0;
  lines.forEach((line, idx) => {
    LINK_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = LINK_TOKEN_RE.exec(line))) {
      const token = m[1];
      if (token.includes('YYYY') || token.includes('<') || token.includes('>') || token.includes('*') || token.startsWith('http')) continue;
      if (!token.includes('/') && !token.endsWith('.md')) continue;
      const opener = m[0].length > token.length ? m[0][0] : '';
      if (!token.includes('/') && opener !== '`' && opener !== '(') continue; // bare prose word, not a path
      checked++;
      const cand1 = path.resolve(root, token);
      const cand2 = path.resolve(path.dirname(abs), token);
      if (fs.existsSync(cand1) || fs.existsSync(cand2)) continue;
      details.push({ path: config.index, line: idx + 1, reason: `link target not found: ${token}` });
    }
  });
  const summary = `${checked} links checked`;
  return { name: 'index-links', status: details.length ? 'FAIL' : 'PASS', summary, details };
}

// --- output ---

function printCheck(check, quiet) {
  if (check.status !== 'FAIL' && quiet) return;
  process.stdout.write(`${check.status} ${check.name}  ${check.summary}\n`);
  if (check.status === 'FAIL' || (!quiet && check.details.length)) {
    for (const d of check.details.slice(0, 20)) {
      const loc = d.line != null ? `${d.path}:${d.line}` : d.path;
      process.stdout.write(`  ${loc}  ${trim160(d.reason)}\n`);
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    process.exit(0);
  }
  const root = path.resolve(opts.root);
  const config = loadConfig(root, opts.config);
  const diff = getDiff(root, opts);

  const checks = [
    checkRomCaps(config, root),
    checkRamCaps(config, root, diff),
    checkDiskProvenance(config, root, diff),
    checkDiskHistory(config, root, diff),
    checkTapeFrozen(config, root, diff),
    checkIndexLinks(config, root),
  ];

  const failedCount = checks.filter((c) => c.status === 'FAIL').length;
  const result = failedCount > 0 ? 'FAIL' : 'PASS';

  if (opts.json) {
    const out = {
      version: VERSION,
      root,
      diff: { mode: diff.mode, files: diff.files, added: diff.added, removed: diff.removed },
      checks: checks.map((c) => ({ name: c.name, status: c.status, summary: c.summary, details: c.details })),
      result,
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(result === 'PASS' ? 0 : 1);
  }

  if (!opts.quiet) {
    process.stdout.write(`memory-lint ${VERSION} root=${root} diff=${diff.mode} (${diff.files} files, ${diff.added} added / ${diff.removed} removed lines)\n`);
  }
  for (const c of checks) printCheck(c, opts.quiet);
  process.stdout.write(`RESULT ${result} (${failedCount} of ${checks.length} checks failed)\n`);
  process.exit(result === 'PASS' ? 0 : 1);
}

main();
