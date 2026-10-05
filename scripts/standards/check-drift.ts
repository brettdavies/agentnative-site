#!/usr/bin/env bun
// Compare every source pinned in src/data/standards/watch.yaml against its
// live upstream value and print a JSON drift report on stdout.
//
// Usage: bun scripts/standards/check-drift.ts
//
// GITHUB_TOKEN, when set, authenticates the api.github.com reads and is sent
// to no other host. Unauthenticated, GitHub allows 60 requests an hour per IP,
// which a shared CI runner address can exhaust before the poll runs.
//
// Exit codes:
//   0  every source matches its pin
//   1  at least one source drifted (report.drifted lists each with old and new)
//   2  at least one source could not be checked, or the manifest is invalid
//      (report.errors); drift found in the same run is still listed
//
// Pinned file hashes are `sha256:<hex>` over the canonical form named by the
// entry's `canonicalization`: `json` parses the document and re-serializes it
// with object keys sorted recursively and no whitespace; `none` hashes the
// bytes as served. Structured values (PR state, draft revision, status code,
// JSON field) compare by the same sorted-key serialization on both sides, so
// the manifest's key order never matters. Re-pinning a reviewed change means
// copying the report's `new` value into the entry's `pinned`.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

const TIERS = ['rfc', 'spec', 'draft', 'proposal', 'convention'] as const;
export const SOURCE_TYPES = ['github-pr', 'github-file', 'url-status', 'ietf-draft', 'json-field'] as const;
const CANONICALIZATIONS = ['json', 'none'] as const;

export const MANIFEST_REPO_PATH = 'src/data/standards/watch.yaml';
export const MANIFEST_PATH = join(import.meta.dir, '..', '..', MANIFEST_REPO_PATH);
const SELF_COMMAND = 'bun scripts/standards/check-drift.ts';

type Tier = (typeof TIERS)[number];
type SourceType = (typeof SOURCE_TYPES)[number];
type Canonicalization = (typeof CANONICALIZATIONS)[number];

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface CheckOptions {
  githubToken?: string;
}

export interface WatchEntry {
  id: string;
  tier: Tier;
  type: SourceType;
  url: string;
  canonicalization: Canonicalization;
  pinned: unknown;
  pointer?: string;
}

export interface DriftEntry {
  id: string;
  tier: Tier;
  type: SourceType;
  url: string;
  old: unknown;
  new: unknown;
}

type SourceErrorReason = 'fetch-failed' | 'http-status' | 'parse-failed';

interface NextStep {
  action: 'retry' | 'fix-manifest';
  command: string;
  docs: string | null;
}

interface SourceError {
  id: string;
  tier: Tier;
  type: SourceType;
  url: string;
  reason: SourceErrorReason;
  message: string;
  next_step: NextStep;
}

interface ManifestError {
  reason: 'manifest-invalid';
  message: string;
  path: string;
  next_step: NextStep;
}

type ReportStatus = 'clean' | 'drift' | 'error';

const EXIT_CODE = { clean: 0, drift: 1, error: 2 } as const;

export interface DriftReport {
  status: ReportStatus;
  exit_code: (typeof EXIT_CODE)[ReportStatus];
  checked: number;
  drifted: DriftEntry[];
  errors: Array<SourceError | ManifestError>;
}

function buildReport(checked: number, drifted: DriftEntry[], errors: DriftReport['errors']): DriftReport {
  const status: ReportStatus = errors.length > 0 ? 'error' : drifted.length > 0 ? 'drift' : 'clean';
  return { status, exit_code: EXIT_CODE[status], checked, drifted, errors };
}

class SourceCheckError extends Error {
  constructor(
    readonly reason: SourceErrorReason,
    message: string,
    readonly action: NextStep['action'] = 'retry',
  ) {
    super(message);
  }
}

// A hung upstream would otherwise hold the whole Promise.all open until the
// CI job's own timeout, and the run would print no report for the healthy
// sources.
const REQUEST_TIMEOUT_MS = 20_000;

// A watched path that answers 404 or 410 has moved or been removed: retrying
// cannot fix it, re-pointing the manifest entry can.
const GONE_STATUSES: ReadonlySet<number> = new Set([404, 410]);

// Rate-limit and server errors say nothing about the watched resource, so a
// url-status source must not read them as a changed status.
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

const GITHUB_PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/;
const GITHUB_BLOB_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/;
const IETF_DRAFT_URL = /^https:\/\/datatracker\.ietf\.org\/doc\/(draft-[a-z0-9-]+)\/$/;
const HTTPS_URL = /^https:\/\/\S+$/;

const URL_SHAPE: Record<SourceType, RegExp> = {
  'github-pr': GITHUB_PR_URL,
  'github-file': GITHUB_BLOB_URL,
  'url-status': HTTPS_URL,
  'ietf-draft': IETF_DRAFT_URL,
  'json-field': HTTPS_URL,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isOneOf<T extends string>(set: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (set as readonly string[]).includes(value);
}

export function parseManifest(text: string): WatchEntry[] {
  const doc: unknown = yaml.load(text);
  if (!isRecord(doc) || !Array.isArray(doc.sources)) {
    throw new Error('watch manifest: expected a top-level "sources" list');
  }
  const seen = new Set<string>();
  return doc.sources.map((raw: unknown, index): WatchEntry => {
    const where = `watch manifest: sources[${index}]`;
    if (!isRecord(raw)) throw new Error(`${where}: expected a mapping`);
    const { id, tier, type, url, canonicalization, pinned, pointer } = raw;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(`${where}: id must be kebab-case, got ${JSON.stringify(id)}`);
    }
    if (seen.has(id)) throw new Error(`${where}: duplicate id "${id}"`);
    seen.add(id);
    if (!isOneOf(TIERS, tier)) throw new Error(`${where} (${id}): unknown tier ${JSON.stringify(tier)}`);
    if (!isOneOf(SOURCE_TYPES, type)) throw new Error(`${where} (${id}): unknown type ${JSON.stringify(type)}`);
    if (typeof url !== 'string' || !URL_SHAPE[type].test(url)) {
      throw new Error(`${where} (${id}): url ${JSON.stringify(url)} does not fit type ${type}`);
    }
    if (!isOneOf(CANONICALIZATIONS, canonicalization)) {
      throw new Error(`${where} (${id}): unknown canonicalization ${JSON.stringify(canonicalization)}`);
    }
    if (canonicalization === 'none' && type !== 'github-file') {
      throw new Error(`${where} (${id}): canonicalization "none" applies only to github-file`);
    }
    if (pinned === undefined || pinned === null) throw new Error(`${where} (${id}): pinned value is missing`);
    if (type === 'json-field' && (typeof pointer !== 'string' || !pointer.startsWith('/'))) {
      throw new Error(`${where} (${id}): json-field needs a JSON Pointer starting with "/"`);
    }
    const entry: WatchEntry = { id, tier, type, url, canonicalization, pinned };
    if (typeof pointer === 'string') entry.pointer = pointer;
    return entry;
  });
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key]);
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new SourceCheckError('parse-failed', `${what} is not JSON: ${messageOf(err)}`);
  }
}

function canonicalize(body: string, rule: Canonicalization): string {
  return rule === 'json' ? canonicalJson(parseJson(body, 'file body')) : body;
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

async function request(fetchImpl: FetchImpl, url: string, headers: Record<string, string>): Promise<Response> {
  try {
    return await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new SourceCheckError('fetch-failed', `GET ${url} failed: ${messageOf(err)}`);
  }
}

async function okBody(fetchImpl: FetchImpl, url: string, headers: Record<string, string>): Promise<string> {
  const res = await request(fetchImpl, url, headers);
  if (!res.ok) {
    await res.body?.cancel();
    const action = GONE_STATUSES.has(res.status) ? 'fix-manifest' : 'retry';
    throw new SourceCheckError('http-status', `GET ${url} returned HTTP ${res.status}`, action);
  }
  return res.text();
}

function field(doc: unknown, key: string, what: string): unknown {
  if (!isRecord(doc) || !(key in doc)) throw new SourceCheckError('parse-failed', `${what} has no "${key}" field`);
  return doc[key];
}

function resolvePointer(doc: unknown, pointer: string): unknown {
  let node = doc;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(node) && /^\d+$/.test(token) && Number(token) < node.length) node = node[Number(token)];
    else if (isRecord(node) && Object.hasOwn(node, token)) node = node[token];
    else throw new SourceCheckError('parse-failed', `document has no value at ${pointer}`, 'fix-manifest');
  }
  return node;
}

const GITHUB_JSON = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
const GITHUB_RAW = { accept: 'application/vnd.github.raw', 'x-github-api-version': '2022-11-28' };

function githubHeaders(base: Record<string, string>, options: CheckOptions): Record<string, string> {
  return options.githubToken ? { ...base, authorization: `Bearer ${options.githubToken}` } : base;
}

type Fetcher = (entry: WatchEntry, fetchImpl: FetchImpl, options: CheckOptions) => Promise<unknown>;

const FETCHERS: Record<SourceType, Fetcher> = {
  'github-pr': async (entry, fetchImpl, options) => {
    const [, owner, repo, number] = GITHUB_PR_URL.exec(entry.url) ?? [];
    const api = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`;
    const pr = parseJson(await okBody(fetchImpl, api, githubHeaders(GITHUB_JSON, options)), 'pull request');
    return {
      state: field(pr, 'state', 'pull request'),
      merged: field(pr, 'merged', 'pull request'),
      head_sha: field(field(pr, 'head', 'pull request'), 'sha', 'pull request head'),
    };
  },
  'github-file': async (entry, fetchImpl, options) => {
    const [, owner, repo, ref, path] = GITHUB_BLOB_URL.exec(entry.url) ?? [];
    const api = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
    const body = await okBody(fetchImpl, api, githubHeaders(GITHUB_RAW, options));
    return sha256(canonicalize(body, entry.canonicalization));
  },
  'url-status': async (entry, fetchImpl) => {
    const res = await request(fetchImpl, entry.url, {});
    await res.body?.cancel();
    if (res.status !== entry.pinned && isTransientStatus(res.status)) {
      throw new SourceCheckError('http-status', `GET ${entry.url} returned HTTP ${res.status}`);
    }
    return res.status;
  },
  'ietf-draft': async (entry, fetchImpl) => {
    const doc = parseJson(await okBody(fetchImpl, `${entry.url}doc.json`, { accept: 'application/json' }), 'draft');
    return { rev: field(doc, 'rev', 'draft'), state: field(doc, 'state', 'draft') };
  },
  'json-field': async (entry, fetchImpl) => {
    const doc = parseJson(await okBody(fetchImpl, entry.url, { accept: 'application/json' }), 'document');
    return resolvePointer(doc, entry.pointer ?? '');
  },
};

type Outcome = { kind: 'match' } | { kind: 'drift'; drift: DriftEntry } | { kind: 'error'; error: SourceError };

async function checkEntry(entry: WatchEntry, fetchImpl: FetchImpl, options: CheckOptions): Promise<Outcome> {
  const { id, tier, type, url } = entry;
  try {
    const observed = await FETCHERS[type](entry, fetchImpl, options);
    if (canonicalJson(observed) === canonicalJson(entry.pinned)) return { kind: 'match' };
    return { kind: 'drift', drift: { id, tier, type, url, old: entry.pinned, new: observed } };
  } catch (err) {
    const reason = err instanceof SourceCheckError ? err.reason : 'fetch-failed';
    const action = err instanceof SourceCheckError ? err.action : 'retry';
    const next_step: NextStep = { action, command: SELF_COMMAND, docs: null };
    return { kind: 'error', error: { id, tier, type, url, reason, message: messageOf(err), next_step } };
  }
}

export async function checkDrift(
  entries: WatchEntry[],
  fetchImpl: FetchImpl,
  options: CheckOptions = {},
): Promise<DriftReport> {
  const outcomes = await Promise.all(entries.map((entry) => checkEntry(entry, fetchImpl, options)));
  const drifted = outcomes.flatMap((o) => (o.kind === 'drift' ? [o.drift] : []));
  const errors = outcomes.flatMap((o) => (o.kind === 'error' ? [o.error] : []));
  return buildReport(entries.length, drifted, errors);
}

async function main(): Promise<number> {
  let entries: WatchEntry[];
  try {
    entries = parseManifest(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (err) {
    const next_step: NextStep = { action: 'fix-manifest', command: SELF_COMMAND, docs: null };
    const error: ManifestError = { reason: 'manifest-invalid', message: messageOf(err), path: MANIFEST_PATH, next_step };
    const report = buildReport(0, [], [error]);
    console.log(JSON.stringify(report, null, 2));
    return report.exit_code;
  }
  const report = await checkDrift(entries, fetch, { githubToken: process.env.GITHUB_TOKEN || undefined });
  console.log(JSON.stringify(report, null, 2));
  return report.exit_code;
}

if (import.meta.main) process.exit(await main());
