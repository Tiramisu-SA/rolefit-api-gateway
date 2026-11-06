/**
 * Shared helpers for the performance scripts (measure-performance.mjs and
 * load-test.mjs): settings, Supabase sign-in, timed gateway calls, statistics
 * and result files. Settings come from the environment, scripts/perf.env and
 * deploy/.env (in that order); see scripts/perf.env.example.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT_DIR = path.join(SCRIPTS_DIR, 'perf-results');
/** NFR: normal (non-AI) operations respond within 2 s. */
export const NORMAL_TARGET_MS = 2_000;

export function fail(message) {
  console.error(`${path.basename(process.argv[1])}: ${message}`);
  process.exit(2);
}

export function positiveInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`${name} must be a whole number above 0 (got "${value}")`);
  return n;
}

/** Fills in settings that are not already in the environment. Returns the gateway URL. */
export function loadSettings() {
  for (const file of [path.join(SCRIPTS_DIR, 'perf.env'), path.join(SCRIPTS_DIR, '..', 'deploy', '.env')]) {
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) process.env[key] ??= value;
  }
  return (process.env.GATEWAY_URL || 'http://localhost:8080').replace(/\/+$/, '');
}

/** The test seeker's access token: PERF_SEEKER_TOKEN, or a Supabase email + password sign-in. */
export async function signIn() {
  if (process.env.PERF_SEEKER_TOKEN) return process.env.PERF_SEEKER_TOKEN;
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, PERF_SEEKER_EMAIL, PERF_SEEKER_PASSWORD } = process.env;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !PERF_SEEKER_EMAIL || !PERF_SEEKER_PASSWORD) {
    fail('set PERF_SEEKER_EMAIL, PERF_SEEKER_PASSWORD, SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or PERF_SEEKER_TOKEN). See scripts/perf.env.example.');
  }
  const res = await fetch(`${SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: PERF_SEEKER_EMAIL, password: PERF_SEEKER_PASSWORD }),
  }).catch((err) => fail(`cannot reach Supabase: ${err.message}`));
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) fail(`Supabase sign-in failed (${res.status}): ${body.error_description ?? body.msg ?? 'no access token'}`);
  return body.access_token;
}

const errorCode = (text, status) => {
  try {
    return JSON.parse(text).error?.code ?? `HTTP_${status}`;
  } catch {
    return `HTTP_${status}`;
  }
};

/** Calls to the gateway as the signed-in test seeker. */
export function gatewayClient(baseUrl, token) {
  return {
    baseUrl,

    /** One untimed call, for setup. Returns the status and the parsed JSON body (or null). */
    async call(method, urlPath) {
      const res = await fetch(baseUrl + urlPath, { method, headers: { Authorization: `Bearer ${token}` } }).catch((err) =>
        fail(`cannot reach the gateway at ${baseUrl}: ${err.message}. Is "docker compose up" running?`),
      );
      return { status: res.status, body: await res.json().catch(() => null) };
    },

    /**
     * Times one request until the whole body has arrived. The X-Request-Id is
     * sent along, so a slow call can be found in every service's logs.
     */
    async timed({ method, path: urlPath, headers, body, requestId, timeoutMs }) {
      const start = performance.now();
      try {
        const res = await fetch(baseUrl + urlPath, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'X-Request-Id': requestId, ...headers },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        return { ms: performance.now() - start, status: res.status, requestId, error: res.ok ? undefined : errorCode(text, res.status) };
      } catch (err) {
        return { ms: performance.now() - start, status: 0, requestId, error: err.name === 'TimeoutError' ? 'CLIENT_TIMEOUT' : 'NETWORK_ERROR' };
      }
    },
  };
}

/** Checks the test seeker can be used and picks the job (PERF_JOB_ID or the first open job). */
export async function prepare(client) {
  const profile = await client.call('GET', '/api/candidates/profiles/me');
  if (profile.status === 401 || profile.status === 403) fail(`the gateway rejected the token (${profile.status}). Use a job seeker account.`);
  if (profile.status === 404) fail('the test seeker has no profile yet. Sign in on the web app and create one first.');

  let jobId = process.env.PERF_JOB_ID;
  if (!jobId) {
    const jobs = await client.call('GET', '/api/jobs');
    jobId = jobs.body?.jobs?.[0]?.id;
    if (!jobId) fail('no open job found. Create one as a recruiter, or set PERF_JOB_ID.');
  }
  return jobId;
}

/** "View resume draft" needs a draft to exist; makes one (untimed) if the seeker has none. */
export async function ensureDraft(client, jobId) {
  const job = encodeURIComponent(jobId);
  if ((await client.call('GET', `/api/resumes/drafts/${job}`)).status === 404) await client.call('POST', `/api/resumes/drafts/${job}/generate`);
}

// ---------- statistics ----------

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted, p) {
  return sorted.length ? sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] : NaN;
}

/**
 * Counts, error rate and latency percentiles of successful calls. With `seconds`,
 * also throughput: successful calls per second, so fast failures under overload
 * do not look like more work done.
 */
export function summarize(results, seconds) {
  const okMs = results.filter((r) => !r.error).map((r) => r.ms).sort((a, b) => a - b);
  const errors = {};
  for (const r of results) if (r.error) errors[r.error] = (errors[r.error] ?? 0) + 1;
  return {
    requests: results.length,
    ok: okMs.length,
    errors,
    errorRate: results.length ? (results.length - okMs.length) / results.length : 0,
    throughput: seconds ? okMs.length / seconds : undefined,
    minMs: okMs[0] ?? NaN,
    p50Ms: percentile(okMs, 50),
    p95Ms: percentile(okMs, 95),
    p99Ms: percentile(okMs, 99),
    maxMs: okMs.at(-1) ?? NaN,
    meanMs: okMs.length ? okMs.reduce((a, b) => a + b, 0) / okMs.length : NaN,
  };
}

// ---------- output ----------

export const fmt = (ms) => (Number.isNaN(ms) ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
export const pct = (rate) => `${(rate * 100).toFixed(rate && rate < 0.01 ? 2 : 1)}%`;
export const pad = (text, width) => String(text).padEnd(width);
export const errorList = (errors) => Object.entries(errors).map(([code, n]) => `${code}×${n}`).join(' ');

export function machineInfo() {
  const cpus = os.cpus();
  return `${os.type()} ${os.release()}, ${cpus[0]?.model.trim() ?? 'unknown CPU'} × ${cpus.length}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, Node ${process.version}`;
}

export const now = () => new Date().toISOString().replace('T', ' ').slice(0, 16);

/** Writes <prefix>-<timestamp>.json and .md to `outDir` and prints where. */
export function writeResults(outDir, prefix, data, markdown) {
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonFile = path.join(outDir, `${prefix}-${stamp}.json`);
  const mdFile = path.join(outDir, `${prefix}-${stamp}.md`);
  writeFileSync(jsonFile, JSON.stringify(data, null, 2));
  writeFileSync(mdFile, `${markdown}\n`);
  console.log(`\nSaved ${path.relative(process.cwd(), jsonFile)} and ${path.relative(process.cwd(), mdFile)}`);
}
