#!/usr/bin/env node

/**
 * gmail-reply-scan.mjs — personal, gws-CLI-based Gmail search into the
 * reply-watch.mjs classification pipeline.
 *
 * reply-watch.mjs already classifies employer replies (Interview / Responded /
 * Need Action / Rejected / Offer / Auto-confirmation / Noise / Unknown),
 * matches them to tracker rows, and prompts before touching
 * data/applications.md — but its only input is data/reply-candidates.json.
 * Until now the only way to populate that file was pasting an email by hand
 * (paste-reply.mjs). The documented Gmail-scanner feature request (#1583) is
 * a plugin-architecture build (OAuth env credentials, a new engine hook) that
 * nobody has shipped yet.
 *
 * This script is a narrower, personal alternative for a machine that already
 * has the `gws` (Google Workspace CLI) binary authenticated: it does ONE job,
 * same boundary as paste-reply.mjs — normalize real Gmail search hits into the
 * exact candidate shape reply-watch.mjs expects and append them to
 * data/reply-candidates.json. It never sets `signal` (classification stays
 * reply-watch.mjs's job), never classifies anything itself, never runs
 * reply-watch.mjs, and never touches data/applications.md.
 *
 * Safety (mirrors #1583's own safety constraints even though this isn't that
 * plugin build):
 *   - Read-only Gmail calls only: `gmail.users.messages.list` and
 *     `.get` (format: metadata). No send/reply/delete/archive/label call is
 *     ever made.
 *   - Fails closed: any `gws` invocation error (auth, network, malformed
 *     JSON) aborts before any file is written — never a partial candidates
 *     file or a corrupted cursor.
 *   - A processed-message cursor (data/reply-scan-state.json) means re-running
 *     the scan never appends the same message twice.
 *
 * The search itself is scoped two ways, so it never becomes an open-ended
 * mailbox read:
 *   1. Sender-domain net — company domains guessed/known from tracker rows
 *      currently sitting in an "awaiting a reply" status (Applied, Responded,
 *      Interview), via reply-matcher.mjs's own getAppDomains().
 *   2. Keyword net — the exact non-noise keyword categories classifyReply()
 *      itself uses (interview/offer/rejection/auto-confirmation/need-action/
 *      responded). Sharing the list means the scanner can never fetch a
 *      message classifyReply() wouldn't itself recognize as a signal, and the
 *      two lists can't drift apart into competing definitions of "relevant".
 * Both are bounded to `--days` (default 21).
 *
 * Usage:
 *   node gmail-reply-scan.mjs [--days N] [--max-results N] [--dry-run]
 *   node gmail-reply-scan.mjs --help
 *
 * Env:
 *   CAREER_OPS_TRACKER            tracker path override (matches every other
 *                                 script here)
 *   CAREER_OPS_REPLY_CANDIDATES   candidates JSON path override (matches
 *                                 paste-reply.mjs/reply-watch.mjs's default)
 *   CAREER_OPS_REPLY_SCAN_STATE   processed-message cursor path override
 *   CAREER_OPS_GWS_BIN            `gws` binary path override (tests only)
 */

import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  getAppDomains, noiseKeywords, offerKeywords, rejectionKeywords,
  autoKeywords, actionKeywords, interviewKeywords, respondedKeywords,
} from './reply-matcher.mjs';
import { loadTrackerApps, loadFollowups } from './lib/reply-tracker-io.mjs';
import { resolveTrackerPath, resolveWorkspaceRoot, writeFileAtomic } from './tracker-utils.mjs';
import { flagValue, hasFlag, validateFlags, safeIntFlag } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPS_FILE = resolveTrackerPath(__dirname);
const WORKSPACE_ROOT = resolveWorkspaceRoot(APPS_FILE);
const CANDIDATES_PATH = process.env.CAREER_OPS_REPLY_CANDIDATES
  || path.join(WORKSPACE_ROOT, 'data', 'reply-candidates.json');
const STATE_PATH = process.env.CAREER_OPS_REPLY_SCAN_STATE
  || path.join(WORKSPACE_ROOT, 'data', 'reply-scan-state.json');
const FOLLOWUPS_FILE = path.join(WORKSPACE_ROOT, 'data', 'follow-ups.md');
const GWS_BIN = process.env.CAREER_OPS_GWS_BIN || 'gws';

// Statuses worth scanning for a reply. Terminal statuses (Offer, Hired,
// Rejected, Discarded, SKIP) and pre-application ones (Evaluated) are not —
// see templates/states.yml for the full canonical set.
export const WATCH_STATUSES = ['Applied', 'Responded', 'Interview'];

const DEFAULT_DAYS = 21;
const DEFAULT_MAX_RESULTS = 100;

/**
 * The union of classifyReply()'s non-noise keyword categories, deduped.
 * Deliberately excludes noiseKeywords — a scanner has no reason to go fetch
 * messages classifyReply() will only turn around and label Noise.
 * @returns {string[]}
 */
export function nonNoiseKeywords() {
  return Array.from(new Set([
    ...offerKeywords, ...rejectionKeywords, ...autoKeywords,
    ...actionKeywords, ...interviewKeywords, ...respondedKeywords,
  ]));
}

/** Wrap a search term in quotes only when it needs them (contains whitespace). */
function quoteTerm(term) {
  return term.includes(' ') ? `"${term}"` : term;
}

/**
 * Build the bounded Gmail search queries for one scan run:
 *   1. A precise sender-domain query (only when at least one watched app has
 *      a known/guessed domain).
 *   2. One keyword query PER watched company, requiring the company's own
 *      name to appear alongside a non-noise signal phrase. A blind, inbox-
 *      wide keyword net (no company requirement) was tried first and matched
 *      soccer-league admin mail, hosting-provider notifications, and travel
 *      newsletters on bare words like "deadline"/"assessment"/"reach out" —
 *      those keywords only carry signal in combination with a corroborating
 *      company/domain match downstream (matchCandidates()'s own scoring), and
 *      a pre-scoring FETCH filter needs that same corroboration up front or
 *      it just pulls in the whole mailbox.
 * Every query carries the same `newer_than:{days}d` bound. Exported for
 * direct unit testing.
 *
 * @param {object[]} watchedApps - Tracker rows already filtered to WATCH_STATUSES.
 * @param {object[]} followups - Rows from data/follow-ups.md.
 * @param {number} days - Lookback window in days.
 * @returns {{label: string, query: string}[]}
 */
export function buildQueries(watchedApps, followups, days) {
  const domains = new Set();
  for (const app of watchedApps) {
    for (const d of getAppDomains(app, followups)) domains.add(d);
  }

  const bound = `newer_than:${days}d`;
  const queries = [];

  if (domains.size > 0) {
    const clause = Array.from(domains).map(d => `from:${d}`).join(' OR ');
    queries.push({ label: 'sender-domain', query: `${bound} (${clause})` });
  }

  const keywordClause = nonNoiseKeywords().map(quoteTerm).join(' OR ');
  const companies = new Set(
    watchedApps.map(a => a.company).filter(c => c && c !== '?')
  );
  for (const company of companies) {
    queries.push({
      label: `company:${company}`,
      query: `${bound} "${company}" (${keywordClause})`,
    });
  }

  return queries;
}

/** Run `gws` with argv, parse its JSON stdout. Throws with the raw stderr on any failure. */
function runGws(args) {
  let stdout;
  try {
    stdout = execFileSync(GWS_BIN, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).slice(0, 500) : err.message;
    throw new Error(`gws ${args.slice(0, 2).join(' ')} failed: ${stderr}`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`gws ${args.slice(0, 2).join(' ')} returned non-JSON output: ${stdout.slice(0, 200)}`);
  }
}

/**
 * List message ids matching a Gmail search query. Read-only
 * (`gmail.users.messages.list`). Exported for direct unit testing against a
 * stub `gws`.
 * @param {string} query
 * @param {number} maxResults
 * @returns {string[]}
 */
export function listMessageIds(query, maxResults) {
  const params = JSON.stringify({ userId: 'me', q: query, maxResults, includeSpamTrash: true });
  const data = runGws(['gmail', 'users', 'messages', 'list', '--params', params, '--format', 'json']);
  return (data.messages || []).map(m => m.id);
}

/**
 * Fetch one message's From/Subject/Date headers plus Gmail's own snippet.
 * Read-only (`gmail.users.messages.get`, `format: metadata` — the lightest
 * fetch that still returns `snippet`, so nothing beyond what matching/
 * classification needs is ever pulled off the message body). Exported for
 * direct unit testing against a stub `gws`.
 * @param {string} id
 * @returns {{ id: string, from: string, subject: string, snippet: string }}
 */
export function fetchMessageMeta(id) {
  const params = JSON.stringify({
    userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'],
  });
  const data = runGws(['gmail', 'users', 'messages', 'get', '--params', params, '--format', 'json']);
  const headers = {};
  for (const h of (data.payload && data.payload.headers) || []) headers[h.name] = h.value;
  return { id, from: headers.From || '', subject: headers.Subject || '', snippet: data.snippet || '' };
}

/**
 * Normalize one fetched message into the exact candidate shape
 * reply-watch.mjs expects. `signal` is deliberately left null — see the file
 * header for why. Exported for direct unit testing.
 * @param {{ id: string, from: string, subject: string, snippet: string }} meta
 */
export function normalizeMessage(meta) {
  return {
    message_id: meta.id,
    from: meta.from || '',
    subject: meta.subject || '',
    body_snippet: meta.snippet || '',
    signal: null,
  };
}

/** Load the processed-message cursor. Returns an empty cursor if absent/corrupt. */
export function loadState(statePath) {
  if (!existsSync(statePath)) return { seenMessageIds: [] };
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8'));
    return { seenMessageIds: Array.isArray(parsed.seenMessageIds) ? parsed.seenMessageIds : [] };
  } catch {
    // A corrupt cursor must never crash the scan or silently re-scan the
    // world — treat it as empty and let this run's write repair it.
    return { seenMessageIds: [] };
  }
}

/** Persist the processed-message cursor atomically (write-then-rename). */
export function saveState(statePath, state) {
  writeFileAtomic(statePath, JSON.stringify(state, null, 2));
}

/**
 * Append new candidates to the candidates JSON file in one locked
 * read/modify/write, creating the file/array if missing. Never disturbs
 * existing entries — same additive contract as paste-reply.mjs's
 * appendCandidate(), batched for a whole scan run instead of one call per
 * candidate. Returns the total candidate count after the append.
 */
export function appendCandidates(newCandidates, candidatesPath) {
  let candidates = [];
  if (existsSync(candidatesPath)) {
    const parsed = JSON.parse(readFileSync(candidatesPath, 'utf-8'));
    if (!Array.isArray(parsed)) {
      throw new Error(`Existing candidates file at ${candidatesPath} is not a JSON array`);
    }
    candidates = parsed;
  }
  candidates.push(...newCandidates);
  writeFileAtomic(candidatesPath, JSON.stringify(candidates, null, 2));
  return candidates.length;
}

const KNOWN_FLAGS = ['--days', '--max-results', '--dry-run', '--help', '-h'];
const VALUE_FLAGS = ['--days', '--max-results'];
const USAGE = 'Usage: node gmail-reply-scan.mjs [--days N] [--max-results N] [--dry-run]';

async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS });

  const days = safeIntFlag(flagValue(args, '--days'), DEFAULT_DAYS);
  const maxResults = safeIntFlag(flagValue(args, '--max-results'), DEFAULT_MAX_RESULTS);
  const dryRun = hasFlag(args, '--dry-run');

  const apps = loadTrackerApps(APPS_FILE);
  const watched = apps.filter(a => WATCH_STATUSES.includes(a.status));

  if (watched.length === 0) {
    console.log(`No applications in ${WATCH_STATUSES.join('/')} status — nothing to scan.`);
    return;
  }

  const followups = loadFollowups(FOLLOWUPS_FILE);
  const queries = buildQueries(watched, followups, days);
  const state = loadState(STATE_PATH);
  const seen = new Set(state.seenMessageIds);

  let fetchedIds;
  try {
    const idSet = new Set();
    for (const { query } of queries) {
      for (const id of listMessageIds(query, maxResults)) idSet.add(id);
    }
    fetchedIds = Array.from(idSet);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const newIds = fetchedIds.filter(id => !seen.has(id));

  if (newIds.length === 0) {
    console.log(`Scanned ${watched.length} watched application(s) across ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}, last ${days}d — no new messages.`);
    return;
  }

  let newCandidates;
  try {
    newCandidates = newIds.map(id => normalizeMessage(fetchMessageMeta(id)));
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Found ${newCandidates.length} new message(s):`);
  for (const c of newCandidates) {
    console.log(`  - ${c.from} — ${c.subject}`);
  }

  if (dryRun) {
    console.log('\n--dry-run: not writing candidates file or cursor.');
    return;
  }

  const total = appendCandidates(newCandidates, CANDIDATES_PATH);
  saveState(STATE_PATH, { seenMessageIds: [...seen, ...newIds] });

  console.log(`\nAppended to ${CANDIDATES_PATH} (${total} candidate(s) total).`);
  console.log('Run `node reply-watch.mjs` to classify and review suggested tracker updates.');
}

if (isMainModule(import.meta.url)) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exitCode = 1;
  });
}
