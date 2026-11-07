#!/usr/bin/env node
/**
 * Measures RoleFit response times through the API Gateway against the
 * performance NFR: normal requests within 2 s, AI requests within 10–20 s.
 *
 *   node scripts/measure-performance.mjs [--runs 20] [--ai-runs 5] [--concurrency 1] [--only normal|ai]
 *
 * Signs in as a test job seeker, times each route `--runs` times after one
 * untimed warm-up call, and prints min / p50 / p95 / max. A route passes when
 * every call succeeds and p95 is within its target. Results are also written to
 * scripts/perf-results/ as JSON and as a Markdown table for the report. Exit
 * code 1 when any route fails. For behaviour under many users, see load-test.mjs.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  DEFAULT_OUT_DIR,
  ensureDraft,
  errorList,
  fail,
  fmt,
  gatewayClient,
  loadSettings,
  machineInfo,
  NORMAL_TARGET_MS,
  now,
  pad,
  positiveInt,
  prepare,
  signIn,
  summarize,
  writeResults,
} from './perf-lib.mjs';

const AI_TARGET_MS = 20_000;
/** Lower end of the AI range: reported as a goal, the 20 s target decides pass/fail. */
const AI_GOAL_MS = 10_000;
/** The gateway's proxy timeout for services with AI routes (AI_PROXY_TIMEOUT_MS in src/proxy/service-proxy.ts). */
const GATEWAY_PROXY_TIMEOUT_MS = 30_000;

const USAGE = `Usage: node scripts/measure-performance.mjs [options]

  --runs <n>         timed calls per normal route (default 20)
  --ai-runs <n>      timed calls per AI route (default 5; each one uses the AI provider's quota)
  --concurrency <n>  parallel calls for normal routes (default 1). AI routes always run one at a time.
  --only <group>     "normal" or "ai"
  --out <dir>        where to write results (default scripts/perf-results)
  -h, --help         show this help

Settings (environment, scripts/perf.env or deploy/.env):
  GATEWAY_URL                default http://localhost:8080
  SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY
  PERF_SEEKER_EMAIL, PERF_SEEKER_PASSWORD   a test job seeker account that has a profile
  PERF_SEEKER_TOKEN          instead of email + password: an access token
  PERF_JOB_ID                job to use (default: the first open job)
  PERF_RESUME_FILE           a .pdf or .docx resume; adds the resume parsing (FR-02) route`;

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      runs: { type: 'string', default: '20' },
      'ai-runs': { type: 'string', default: '5' },
      concurrency: { type: 'string', default: '1' },
      only: { type: 'string' },
      out: { type: 'string', default: DEFAULT_OUT_DIR },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (err) {
  fail(`${err.message}\n\n${USAGE}`);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const runs = positiveInt('--runs', args.runs);
const aiRuns = positiveInt('--ai-runs', args['ai-runs']);
const concurrency = positiveInt('--concurrency', args.concurrency);
if (args.only && args.only !== 'normal' && args.only !== 'ai') fail('--only must be "normal" or "ai"');
const gatewayUrl = loadSettings();

// ---------- routes ----------

const RESUME_TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function buildRoutes(jobId) {
  const job = encodeURIComponent(jobId);
  const normal = (id, name, urlPath) => ({ id, group: 'normal', name, method: 'GET', path: urlPath, targetMs: NORMAL_TARGET_MS });
  const ai = (id, name, method, urlPath, extra = {}) => ({ id, group: 'ai', name, method, path: urlPath, targetMs: AI_TARGET_MS, ...extra });

  const routes = [
    normal('jobs-list', 'Browse open jobs', '/api/jobs'),
    normal('job-detail', 'View one job', `/api/jobs/${job}`),
    normal('profile', 'View my profile', '/api/candidates/profiles/me'),
    normal('search', 'Search jobs', '/api/discovery/jobs/search'),
    normal('recommendations', 'Job recommendations', '/api/discovery/recommendations'),
    normal('resume-draft', 'View resume draft', `/api/resumes/drafts/${job}`),
    normal('my-applications', 'My applications', '/api/applications/mine'),
    // Both job fit and match call the AI model for the explanation (FR-10), so they are AI routes.
    ai('job-fit', 'Job fit with explanation (FR-9/FR-10)', 'GET', `/api/discovery/jobs/${job}/fit`),
    ai('match', 'Match explanation (FR-10)', 'GET', `/api/discovery/jobs/${job}/match`),
    ai('resume-generate', 'Tailor resume (FR-11)', 'POST', `/api/resumes/drafts/${job}/generate`),
  ];

  const file = process.env.PERF_RESUME_FILE;
  if (file) {
    const type = RESUME_TYPES[path.extname(file).toLowerCase()];
    if (!type) fail('PERF_RESUME_FILE must be a .pdf or .docx file');
    if (!existsSync(file)) fail(`PERF_RESUME_FILE not found: ${file}`);
    routes.push(
      ai('resume-import', 'Parse uploaded resume (FR-02)', 'POST', '/api/candidates/profiles/me/import-resume', {
        headers: { 'Content-Type': type, 'X-File-Name': encodeURIComponent(path.basename(file)) },
        body: readFileSync(file),
      }),
    );
  }
  return routes.filter((r) => !args.only || r.group === args.only);
}

// ---------- measuring ----------

let sequence = 0;
const timed = (client, route) =>
  client.timed({ ...route, requestId: `perf-${route.id}-${++sequence}`, timeoutMs: route.targetMs * 2 });

async function measure(client, route) {
  const count = route.group === 'ai' ? aiRuns : runs;
  const parallel = route.group === 'ai' ? 1 : Math.min(concurrency, count);
  await timed(client, route); // warm-up: opens connections and fills caches, not counted

  const results = [];
  let started = 0;
  const worker = async () => {
    while (started < count) {
      started++;
      results.push(await timed(client, route));
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));

  const stats = summarize(results);
  const slowest = results.reduce((a, b) => (b.ms > a.ms ? b : a));
  return {
    id: route.id,
    group: route.group,
    name: route.name,
    request: `${route.method} ${route.path}`,
    targetMs: route.targetMs,
    runs: stats.requests,
    ...stats,
    withinAiGoal: route.group === 'ai' && stats.ok ? stats.p95Ms <= AI_GOAL_MS : undefined,
    pass: stats.ok === stats.requests && stats.p95Ms <= route.targetMs,
    slowestRequestId: slowest.requestId,
    // A 503 just after the gateway's proxy timeout means the gateway gave up, not the service.
    cutByGateway: results.some((r) => r.status === 503 && r.ms >= GATEWAY_PROXY_TIMEOUT_MS - 500),
  };
}

// ---------- output ----------

function printRow(r) {
  const errors = errorList(r.errors);
  console.log(
    pad(r.request.length > 52 ? `${r.request.slice(0, 51)}…` : r.request, 53) +
      pad(fmt(r.targetMs), 8) +
      pad(`${r.ok}/${r.runs}`, 7) +
      pad(fmt(r.p50Ms), 10) +
      pad(fmt(r.p95Ms), 10) +
      pad(fmt(r.maxMs), 10) +
      (r.pass ? 'PASS' : 'FAIL') +
      (errors ? `  ${errors}` : ''),
  );
}

function notesFor(results) {
  const notes = [];
  for (const r of results) {
    if (r.cutByGateway) {
      notes.push(
        `${r.name}: the gateway returned 503 after its ${GATEWAY_PROXY_TIMEOUT_MS / 1000} s proxy timeout ` +
          '(src/proxy/service-proxy.ts), below the 20 s AI target. Raise the timeout for AI routes.',
      );
    }
    if (!r.pass) notes.push(`${r.name}: slowest call has request id ${r.slowestRequestId}; search the service logs for it.`);
  }
  return notes;
}

function markdown(meta, results) {
  const row = (r) =>
    `| ${r.name} | \`${r.request}\` | ${fmt(r.targetMs)} | ${r.ok}/${r.runs} | ${fmt(r.p50Ms)} | ${fmt(r.p95Ms)} | ${fmt(r.maxMs)} | ${r.pass ? 'Pass' : 'Fail'} |`;
  const table = (group, title) => {
    const rows = results.filter((r) => r.group === group);
    if (!rows.length) return [];
    return [`### ${title}`, '', '| Action | Request | Target | OK | p50 | p95 | Max | Result |', '|---|---|---|---|---|---|---|---|', ...rows.map(row), ''];
  };
  const notes = notesFor(results);
  return [
    `## Response times (${meta.date})`,
    '',
    `- Gateway: ${meta.gatewayUrl}`,
    `- Machine: ${meta.machine}`,
    `- Calls per route: ${meta.runs} normal (concurrency ${meta.concurrency}), ${meta.aiRuns} AI (one at a time), after one warm-up call`,
    '- Time = from sending the request until the whole response body has arrived. Pass = every call succeeded and p95 ≤ target.',
    '',
    ...table('normal', `Normal requests (target ${NORMAL_TARGET_MS / 1000} s)`),
    ...table('ai', `AI requests (target ${AI_GOAL_MS / 1000}–${AI_TARGET_MS / 1000} s)`),
    ...(notes.length ? ['### Notes', '', ...notes.map((n) => `- ${n}`), ''] : []),
  ].join('\n');
}

// ---------- main ----------

const client = gatewayClient(gatewayUrl, await signIn());
const jobId = await prepare(client);
const routes = buildRoutes(jobId);
if (routes.some((r) => r.id === 'resume-draft')) await ensureDraft(client, jobId);

const meta = { date: now(), gatewayUrl, machine: machineInfo(), jobId, runs, aiRuns, concurrency };
console.log(`Gateway ${gatewayUrl}, job ${jobId}, ${runs} runs per normal route (concurrency ${concurrency}), ${aiRuns} per AI route\n`);
console.log(pad('Request', 53) + pad('Target', 8) + pad('OK', 7) + pad('p50', 10) + pad('p95', 10) + pad('Max', 10) + 'Result');

const results = [];
for (const route of routes) {
  const result = await measure(client, route);
  results.push(result);
  printRow(result);
}

const notes = notesFor(results);
if (notes.length) console.log(`\n${notes.map((n) => `- ${n}`).join('\n')}`);
writeResults(args.out, 'perf', { ...meta, results }, markdown(meta, results));

const failed = results.filter((r) => !r.pass).length;
console.log(failed ? `${failed} of ${results.length} routes FAILED the target.` : `All ${results.length} routes met the target.`);
process.exit(failed ? 1 : 0);
