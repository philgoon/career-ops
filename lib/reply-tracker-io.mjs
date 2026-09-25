/**
 * reply-tracker-io.mjs — shared read-only loaders for the reply-watch pipeline.
 *
 * `loadTrackerApps` and `loadFollowups` were private to reply-watch.mjs. Pulled
 * out here so gmail-reply-scan.mjs (the automated Gmail-search populating path
 * for data/reply-candidates.json, alongside the manual paste-reply.mjs path) can
 * read the exact same tracker/follow-up rows reply-watch.mjs will later match
 * against, without a second hand-rolled markdown-table parser drifting out of
 * sync with the first.
 *
 * Both functions are read-only: they never write data/applications.md or
 * data/follow-ups.md.
 */

import fs from 'node:fs';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';

/**
 * Parse every row of the applications tracker into `{ num, company, role,
 * status, ... }` objects. Returns `[]` if the tracker file doesn't exist yet.
 *
 * @param {string} appsFile - Absolute path to data/applications.md.
 * @returns {object[]}
 */
export function loadTrackerApps(appsFile) {
  if (!fs.existsSync(appsFile)) {
    return [];
  }
  const content = fs.readFileSync(appsFile, 'utf-8');
  const lines = content.split('\n');
  const colmap = resolveColumns(lines);
  const apps = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (row) {
      apps.push(row);
    }
  }
  return apps;
}

/**
 * Parse every row of data/follow-ups.md into `{ num, appNum, date, company,
 * role, channel, contact, notes }` objects. Returns `[]` if the file doesn't
 * exist yet.
 *
 * @param {string} followupsFile - Absolute path to data/follow-ups.md.
 * @returns {object[]}
 */
export function loadFollowups(followupsFile) {
  if (!fs.existsSync(followupsFile)) {
    return [];
  }
  const content = fs.readFileSync(followupsFile, 'utf-8');
  const lines = content.split('\n');
  const followups = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const parts = line.split('|').map(s => s.trim());
    if (parts.length < 8) continue;
    const num = parseInt(parts[1], 10);
    const appNum = parseInt(parts[2], 10);
    if (isNaN(num) || isNaN(appNum)) continue;
    followups.push({
      num,
      appNum,
      date: parts[3],
      company: parts[4],
      role: parts[5],
      channel: parts[6],
      contact: parts[7],
      notes: parts[8] || ''
    });
  }
  return followups;
}
