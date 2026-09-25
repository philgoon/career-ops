#!/usr/bin/env node

/**
 * gmail-reply-scan-tests.mjs — regression tests for gmail-reply-scan.mjs.
 *
 * Locks in:
 *   1. buildQueries() scopes the keyword net per tracked company (never a
 *      blind inbox-wide keyword search) and keeps a precise sender-domain
 *      query alongside it.
 *   2. nonNoiseKeywords() excludes noiseKeywords.
 *   3. normalizeMessage() produces the exact candidate shape reply-watch.mjs
 *      expects, with signal left null.
 *   4. loadState()/saveState() round-trip, and a missing/corrupt cursor
 *      never throws — it degrades to an empty cursor.
 *   5. appendCandidates() is additive and creates a missing file.
 *   6. End-to-end via a stub `gws` binary: new messages get appended,
 *      candidate re-scans are deduped by the cursor, a `gws` failure aborts
 *      before writing any file (fail-closed), and no watched applications
 *      means no `gws` call is made at all.
 *
 * Runs against a stub `gws` and throwaway temp dirs; never touches the repo's
 * real data/reply-candidates.json, data/reply-scan-state.json, or
 * data/applications.md.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const CLI = join(ROOT, 'gmail-reply-scan.mjs');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Write a stub `gws` executable into `dir` and return its path.
 *
 * Behavior driven entirely by env vars so each test can shape it without a
 * shared fixture file:
 *   STUB_FAIL=1            — exit 1 with a fixed stderr message (any subcommand).
 *   STUB_LIST_IDS          — comma-separated ids to return from messages.list.
 *   STUB_META_<id>         — JSON `{from,subject,snippet}` for messages.get on
 *                            that id (id's own non-alnum chars stripped for
 *                            the env var name).
 */
function writeStubGws(dir) {
  const stubPath = join(dir, 'gws-stub.mjs');
  writeFileSync(stubPath, `#!/usr/bin/env node
if (process.env.STUB_FAIL === '1') {
  process.stderr.write('stub gws: simulated auth failure\\n');
  process.exit(1);
}
const args = process.argv.slice(2);
const sub = args[3]; // args: gmail users messages <list|get> ...
if (sub === 'list') {
  const ids = (process.env.STUB_LIST_IDS || '').split(',').filter(Boolean);
  process.stdout.write(JSON.stringify({ messages: ids.map(id => ({ id, threadId: id })) }));
} else if (sub === 'get') {
  const paramsIdx = args.indexOf('--params');
  const params = JSON.parse(args[paramsIdx + 1]);
  const key = 'STUB_META_' + params.id.replace(/[^a-zA-Z0-9]/g, '_');
  const meta = JSON.parse(process.env[key] || '{"from":"","subject":"","snippet":""}');
  process.stdout.write(JSON.stringify({
    payload: { headers: [{ name: 'From', value: meta.from }, { name: 'Subject', value: meta.subject }] },
    snippet: meta.snippet,
  }));
} else {
  process.stderr.write('stub gws: unknown subcommand\\n');
  process.exit(1);
}
`, { mode: 0o755 });
  chmodSync(stubPath, 0o755);
  return stubPath;
}

function setupWorkspace() {
  const dir = tmp('gmail-reply-scan-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const trackerFile = join(dataDir, 'applications.md');
  const candidatesFile = join(dataDir, 'reply-candidates.json');
  const stateFile = join(dataDir, 'reply-scan-state.json');
  return { dir, dataDir, trackerFile, candidatesFile, stateFile };
}

function writeTracker(trackerFile, rows) {
  const header = '# Applications\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|---|---|---|---|---|---|---|---|\n';
  const body = rows.map(r => `| ${r.num} | 2026-09-01 | ${r.company} | ${r.role} | 4.0/5 | ${r.status} | ✅ | - | |\n`).join('');
  writeFileSync(trackerFile, header + body);
}

function runScan(ws, gwsPath, extraArgs = [], extraEnv = {}) {
  return execFileSync(NODE, [CLI, ...extraArgs], {
    cwd: ws.dir,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CAREER_OPS_TRACKER: ws.trackerFile,
      CAREER_OPS_REPLY_CANDIDATES: ws.candidatesFile,
      CAREER_OPS_REPLY_SCAN_STATE: ws.stateFile,
      CAREER_OPS_GWS_BIN: gwsPath,
      ...extraEnv,
    },
  });
}

// ---------------------------------------------------------------------------
console.log('1. buildQueries() scopes keywords per company, never blind inbox-wide');
{
  const mod = await import(pathToFileURL(CLI).href);
  const apps = [{ num: 1, company: 'Acme', role: 'Backend Engineer', status: 'Applied', notes: '' }];
  const queries = mod.buildQueries(apps, [], 21);

  const domainQ = queries.find(q => q.label === 'sender-domain');
  check('sender-domain query present', !!domainQ, JSON.stringify(queries.map(q => q.label)));
  check('sender-domain query guesses acme.com', domainQ.query.includes('from:acme.com'), domainQ.query);

  const companyQ = queries.find(q => q.label === 'company:Acme');
  check('per-company query present', !!companyQ);
  check('per-company query requires the company name', companyQ.query.includes('"Acme"'), companyQ.query);
  check('per-company query excludes a noise term', !companyQ.query.includes('job alert'), companyQ.query);
  check('per-company query includes a real signal phrase', companyQ.query.includes('interview invitation'), companyQ.query);
  check('every query carries the days bound', queries.every(q => q.query.startsWith('newer_than:21d')));

  const noApps = mod.buildQueries([], [], 21);
  check('no watched apps -> no queries at all', noApps.length === 0, JSON.stringify(noApps));
}

// ---------------------------------------------------------------------------
console.log('2. nonNoiseKeywords() excludes noiseKeywords');
{
  const mod = await import(pathToFileURL(CLI).href);
  const { noiseKeywords } = await import(pathToFileURL(join(ROOT, 'reply-matcher.mjs')).href);
  const kws = mod.nonNoiseKeywords();
  check('no overlap with noiseKeywords', noiseKeywords.every(nk => !kws.includes(nk)));
  check('includes a real interview phrase', kws.includes('interview invitation'));
}

// ---------------------------------------------------------------------------
console.log('3. normalizeMessage() shape and null signal');
{
  const mod = await import(pathToFileURL(CLI).href);
  const cand = mod.normalizeMessage({ id: 'm1', from: 'hr@acme.com', subject: 'Re: Backend Engineer', snippet: 'We would like to interview you.' });
  check('message_id maps through', cand.message_id === 'm1');
  check('from/subject/body_snippet map through', cand.from === 'hr@acme.com' && cand.subject === 'Re: Backend Engineer' && cand.body_snippet === 'We would like to interview you.');
  check('signal is null (classification stays reply-watch.mjs\'s job)', cand.signal === null);

  const missing = mod.normalizeMessage({ id: 'm2' });
  check('missing fields default to empty string, not undefined', missing.from === '' && missing.subject === '' && missing.body_snippet === '');
}

// ---------------------------------------------------------------------------
console.log('4. loadState()/saveState() round-trip; missing/corrupt cursor degrades to empty');
{
  const mod = await import(pathToFileURL(CLI).href);
  const dir = tmp('gmail-reply-scan-state-');
  const statePath = join(dir, 'state.json');

  check('missing cursor -> empty seenMessageIds', JSON.stringify(mod.loadState(statePath).seenMessageIds) === '[]');

  mod.saveState(statePath, { seenMessageIds: ['a', 'b'] });
  check('round-trip preserves ids', JSON.stringify(mod.loadState(statePath).seenMessageIds) === JSON.stringify(['a', 'b']));

  writeFileSync(statePath, 'not json{{{');
  check('corrupt cursor degrades to empty rather than throwing', JSON.stringify(mod.loadState(statePath).seenMessageIds) === '[]');
}

// ---------------------------------------------------------------------------
console.log('5. appendCandidates() is additive and creates a missing file');
{
  const mod = await import(pathToFileURL(CLI).href);
  const dir = tmp('gmail-reply-scan-cands-');
  const candidatesPath = join(dir, 'reply-candidates.json');

  const total1 = mod.appendCandidates([{ message_id: 'm1' }], candidatesPath);
  check('first append creates file, returns count 1', total1 === 1 && existsSync(candidatesPath));

  const total2 = mod.appendCandidates([{ message_id: 'm2' }, { message_id: 'm3' }], candidatesPath);
  check('second append is additive, returns count 3', total2 === 3);

  const arr = JSON.parse(readFileSync(candidatesPath, 'utf8'));
  check('first candidate untouched by second append', arr[0].message_id === 'm1');
}

// ---------------------------------------------------------------------------
console.log('6. end-to-end via stub gws: new messages appended, subsequent scan deduped by cursor');
{
  const ws = setupWorkspace();
  writeTracker(ws.trackerFile, [{ num: 1, company: 'Acme', role: 'Backend Engineer', status: 'Applied' }]);
  const gwsPath = writeStubGws(ws.dir);

  const out1 = runScan(ws, gwsPath, [], {
    STUB_LIST_IDS: 'm1',
    STUB_META_m1: JSON.stringify({ from: 'hr@acme.com', subject: 'Interview invitation', snippet: 'We would like to schedule an interview.' }),
  });
  check('first run reports one new message', out1.includes('Found 1 new message'), out1);

  const arr = JSON.parse(readFileSync(ws.candidatesFile, 'utf8'));
  check('candidate appended with exact shape', arr.length === 1 && arr[0].message_id === 'm1' && arr[0].signal === null, JSON.stringify(arr));
  check('state file created with the seen id', JSON.parse(readFileSync(ws.stateFile, 'utf8')).seenMessageIds.includes('m1'));

  // Same message id returned again (e.g. still inside the lookback window) —
  // the cursor must suppress it, not append a duplicate.
  const out2 = runScan(ws, gwsPath, [], {
    STUB_LIST_IDS: 'm1',
    STUB_META_m1: JSON.stringify({ from: 'hr@acme.com', subject: 'Interview invitation', snippet: 'We would like to schedule an interview.' }),
  });
  check('second run with the same id reports no new messages', out2.includes('no new messages'), out2);
  const arrAfter = JSON.parse(readFileSync(ws.candidatesFile, 'utf8'));
  check('candidates file still has exactly one entry (no duplicate)', arrAfter.length === 1, JSON.stringify(arrAfter));
}

// ---------------------------------------------------------------------------
console.log('7. --dry-run never writes the candidates file or cursor');
{
  const ws = setupWorkspace();
  writeTracker(ws.trackerFile, [{ num: 1, company: 'Acme', role: 'Backend Engineer', status: 'Applied' }]);
  const gwsPath = writeStubGws(ws.dir);

  const out = runScan(ws, gwsPath, ['--dry-run'], {
    STUB_LIST_IDS: 'm1',
    STUB_META_m1: JSON.stringify({ from: 'hr@acme.com', subject: 'Interview invitation', snippet: 'schedule an interview' }),
  });
  check('dry-run still reports the found message', out.includes('Found 1 new message'), out);
  check('dry-run leaves no candidates file', !existsSync(ws.candidatesFile));
  check('dry-run leaves no state file', !existsSync(ws.stateFile));
}

// ---------------------------------------------------------------------------
console.log('8. a gws failure aborts before writing any file (fail-closed)');
{
  const ws = setupWorkspace();
  writeTracker(ws.trackerFile, [{ num: 1, company: 'Acme', role: 'Backend Engineer', status: 'Applied' }]);
  const gwsPath = writeStubGws(ws.dir);

  let threw = false;
  try {
    runScan(ws, gwsPath, [], { STUB_FAIL: '1' });
  } catch (err) {
    threw = true;
    check('failure exits non-zero', err.status !== 0, String(err.status));
    check('failure surfaces the gws stderr', String(err.stderr).includes('simulated auth failure') || String(err.stdout).includes('Error'), `${err.stdout}\n${err.stderr}`);
  }
  check('a gws failure throws/exits non-zero', threw);
  check('no candidates file written on failure', !existsSync(ws.candidatesFile));
  check('no state file written on failure', !existsSync(ws.stateFile));
}

// ---------------------------------------------------------------------------
console.log('9. no watched applications -> gws is never invoked, exits 0');
{
  const ws = setupWorkspace();
  writeTracker(ws.trackerFile, [{ num: 1, company: 'Acme', role: 'Backend Engineer', status: 'Rejected' }]);
  // A stub that fails on any subcommand — if the script called gws at all,
  // this test would catch it as a thrown non-zero exit.
  const gwsPath = writeStubGws(ws.dir);

  const out = runScan(ws, gwsPath, [], { STUB_FAIL: '1' });
  check('reports nothing to scan without ever invoking gws', out.includes('nothing to scan'), out);
  check('no candidates file written', !existsSync(ws.candidatesFile));
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
