#!/usr/bin/env node
/**
 * Load and stress tests of RoleFit through the API Gateway.
 *
 *   node scripts/load-test.mjs load   [--users 50] [--duration 60] [--ramp 10] [--think 1]
 *   node scripts/load-test.mjs stress [--stages 10,25,50,100,150,200] [--stage-duration 30] [--think 1]
 *
 * Every virtual user acts as the test job seeker and walks a seeker journey of
 * eight normal (non-AI) requests in a loop, waiting a think time (±50%) between
 * requests, like a person reading each page.
 *
 * - load:   a steady number of users, the NFR's expected "tens of concurrently
 *           active users". Passes when p95 ≤ 2 s and fewer than 1% of requests fail.
 * - stress: more users stage by stage. Reports the largest stage still within
 *           the target, where it breaks, and where throughput stops growing.
 *
 * AI routes are left out: each call uses AI provider quota and its time is the
 * model's, which measure-performance.mjs times separately. Results are written
 * to scripts/perf-results/ as JSON and as Markdown tables for the slides.
 */
import { performance } from 'node:perf_hooks';
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
  pct,
  positiveInt,
  prepare,
  signIn,
  summarize,
  writeResults,
} from './perf-lib.mjs';

/** Pass rule for a load level: p95 within the 2 s target and an error rate below this. */
const ERROR_BUDGET = 0.01;
/** A stress stage that fails more than this stops the test: the system is down, not slow. */
const ABORT_ERROR_RATE = 0.5;
const REQUEST_TIMEOUT_MS = 30_000;
const PROGRESS_EVERY_MS = 5_000;

const USAGE = `Usage: node scripts/load-test.mjs <load|stress> [options]

  load    a steady number of users
    --users <n>             virtual users (default 50)
    --duration <s>          measured seconds after the ramp-up (default 60)
    --ramp <s>              seconds to start all users (default 10)

  stress  more users stage by stage
    --stages <n,n,...>      users per stage (default 10,25,50,100,150,200)
    --stage-duration <s>    seconds per stage (default 30)

  --think <s>               mean pause between a user's requests (default 1)
  --out <dir>               where to write results (default scripts/perf-results)
  -h, --help                show this help

Settings are the same as measure-performance.mjs (scripts/perf.env).`;

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      users: { type: 'string', default: '50' },
      duration: { type: 'string', default: '60' },
      ramp: { type: 'string', default: '10' },
      stages: { type: 'string', default: '10,25,50,100,150,200' },
      'stage-duration': { type: 'string', default: '30' },
      think: { type: 'string', default: '1' },
      out: { type: 'string', default: DEFAULT_OUT_DIR },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (err) {
  fail(`${err.message}\n\n${USAGE}`);
}
const { values: args, positionals } = parsed;
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const mode = positionals[0];
if (mode !== 'load' && mode !== 'stress') fail(`choose "load" or "stress"\n\n${USAGE}`);

function nonNegative(name, value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) fail(`${name} must be a number of 0 or more (got "${value}")`);
  return n;
}

const thinkMs = nonNegative('--think', args.think) * 1000;
const users = positiveInt('--users', args.users);
const durationS = positiveInt('--duration', args.duration);
const rampS = nonNegative('--ramp', args.ramp);
const stageS = positiveInt('--stage-duration', args['stage-duration']);
const stages = args.stages.split(',').map((s) => positiveInt('--stages', s.trim()));
if (stages.some((n, i) => i > 0 && n <= stages[i - 1])) fail('--stages must increase, e.g. 10,25,50,100');
const gatewayUrl = loadSettings();

// ---------- the seeker journey ----------

function journey(jobId) {
  const job = encodeURIComponent(jobId);
  return [
    { id: 'jobs-list', name: 'Browse open jobs', path: '/api/jobs' },
    { id: 'search', name: 'Search jobs', path: '/api/discovery/jobs/search' },
    { id: 'recommendations', name: 'Job recommendations', path: '/api/discovery/recommendations' },
    { id: 'job-detail', name: 'View one job', path: `/api/jobs/${job}` },
    { id: 'job-fit', name: 'Job fit for one job', path: `/api/discovery/jobs/${job}/fit` },
    { id: 'resume-draft', name: 'View resume draft', path: `/api/resumes/drafts/${job}` },
    { id: 'my-applications', name: 'My applications', path: '/api/applications/mine' },
    { id: 'profile', name: 'View my profile', path: '/api/candidates/profiles/me' },
  ].map((step) => ({ ...step, method: 'GET' }));
}

// ---------- virtual users ----------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sequence = 0;

/**
 * One user: walks the journey from step `offset` (so users do not all hit the
 * same route at once) until `run.stopAt`, recording each request.
 */
async function virtualUser(client, steps, offset, run) {
  for (let i = offset; performance.now() < run.stopAt; i++) {
    const step = steps[i % steps.length];
    const at = performance.now();
    const r = await client.timed({ method: step.method, path: step.path, requestId: `load-${step.id}-${++sequence}`, timeoutMs: REQUEST_TIMEOUT_MS });
    run.results.push({ route: step.id, at, ms: r.ms, error: r.error, requestId: r.requestId });
    await sleep(Math.max(0, Math.min(thinkMs * (0.5 + Math.random()), run.stopAt - performance.now())));
  }
}

/** Prints a line every few seconds so a long run shows it is alive. */
function progress(run, activeUsers) {
  const start = performance.now();
  const timer = setInterval(() => {
    const errors = run.results.filter((r) => r.error).length;
    console.log(`  ${pad(`${Math.round((performance.now() - start) / 1000)}s`, 6)}users ${pad(activeUsers(), 5)}requests ${pad(run.results.length, 8)}errors ${errors}`);
  }, PROGRESS_EVERY_MS);
  return () => clearInterval(timer);
}

const withinTarget = (s) => s.ok > 0 && s.p95Ms <= NORMAL_TARGET_MS && s.errorRate < ERROR_BUDGET;

/** Starts `count` users spread over `spreadMs`, numbered from `first`. */
function startUsers(client, steps, run, first, count, spreadMs) {
  return Array.from({ length: count }, async (_, i) => {
    await sleep((spreadMs * i) / count);
    if (performance.now() < run.stopAt) await virtualUser(client, steps, first + i, run);
  });
}

async function loadTest(client, steps) {
  const start = performance.now();
  const steadyFrom = start + rampS * 1000;
  const run = { results: [], stopAt: steadyFrom + durationS * 1000 };
  const stop = progress(run, () => users);
  await Promise.all(startUsers(client, steps, run, 0, users, rampS * 1000));
  stop();

  // Only the steady part counts: during the ramp-up fewer users are active.
  const steady = run.results.filter((r) => r.at >= steadyFrom);
  const overall = summarize(steady, durationS);
  const routes = steps.map((s) => ({ id: s.id, name: s.name, request: `GET ${s.path}`, ...summarize(steady.filter((r) => r.route === s.id), durationS) }));
  const slowest = steady.reduce((a, b) => (b.ms > a.ms ? b : a), { ms: 0 });
  return { overall, routes, pass: withinTarget(overall), slowestRequestId: slowest.requestId };
}

async function stressTest(client, steps) {
  const run = { results: [], stopAt: Infinity };
  const running = [];
  const windows = [];
  let active = 0;
  let aborted = false;
  const stop = progress(run, () => active);

  for (const target of stages) {
    const from = performance.now();
    const added = target - active;
    running.push(...startUsers(client, steps, run, active, added, Math.min(5_000, (stageS * 1000) / 5)));
    active = target;
    await sleep(stageS * 1000);
    windows.push({ users: target, from, to: performance.now() });

    // Calls still running are not in yet; the final table is built after all of them finish.
    const sofar = summarize(run.results.filter((r) => r.at >= from));
    console.log(`  stage ${target} users: p95 ${fmt(sofar.p95Ms)}, errors ${pct(sofar.errorRate)}`);
    if (sofar.errorRate > ABORT_ERROR_RATE) {
      aborted = true;
      console.log(`  more than ${pct(ABORT_ERROR_RATE)} of requests failed: stopping the stress test.`);
      break;
    }
  }
  run.stopAt = performance.now();
  await Promise.all(running);
  stop();

  const stageResults = windows.map((w) => {
    const inStage = run.results.filter((r) => r.at >= w.from && r.at < w.to);
    const s = summarize(inStage, (w.to - w.from) / 1000);
    const routeP95 = steps
      .map((step) => ({ name: step.name, p95Ms: summarize(inStage.filter((r) => r.route === step.id)).p95Ms }))
      .filter((r) => !Number.isNaN(r.p95Ms))
      .sort((a, b) => b.p95Ms - a.p95Ms);
    return { users: w.users, ...s, withinTarget: withinTarget(s), slowestRoute: routeP95[0] };
  });

  const firstBad = stageResults.findIndex((s) => !s.withinTarget);
  const capacity = firstBad === -1 ? stageResults.at(-1) : stageResults[firstBad - 1];
  // Throughput "stops growing" when users went up by half or more but requests per second by under 10%.
  const saturation = stageResults.find((s, i) => i > 0 && s.users >= stageResults[i - 1].users * 1.5 && s.throughput < stageResults[i - 1].throughput * 1.1);
  return { stages: stageResults, capacityUsers: capacity?.users, breaking: firstBad === -1 ? undefined : stageResults[firstBad], saturation, aborted };
}

// ---------- notes and output ----------

/** What the error codes most likely mean, for the interpretation on the slides. */
function errorNotes(errors) {
  const notes = [];
  const codes = Object.keys(errors);
  if (codes.some((c) => c === 'SERVICE_UNAVAILABLE')) notes.push('SERVICE_UNAVAILABLE: the gateway could not reach a service, or the service took longer than the gateway\'s proxy timeout (10 s, or 30 s for services with AI routes).');
  if (codes.some((c) => /TOKEN|HTTP_429/.test(c))) notes.push('Token errors or 429: Supabase Auth limited the token checks. Every request is verified by the gateway, and Candidate Profile and Resume Preparation verify it again.');
  if (codes.includes('CLIENT_TIMEOUT')) notes.push(`CLIENT_TIMEOUT: no answer within ${REQUEST_TIMEOUT_MS / 1000} s.`);
  if (codes.includes('NETWORK_ERROR')) notes.push('NETWORK_ERROR: the connection failed (gateway down, or the test machine ran out of sockets).');
  return notes;
}

function setupLines(meta) {
  return [
    `- Gateway: ${meta.gatewayUrl}`,
    `- Machine: ${meta.machine} (the load generator runs on the same machine as the services)`,
    `- Each virtual user repeats a seeker journey of 8 normal requests (job list, search, recommendations, job detail, job fit, resume draft, my applications, profile) with ${thinkMs / 1000} s ± 50% think time. AI routes are excluded.`,
    `- Target (NFR): p95 ≤ ${NORMAL_TARGET_MS / 1000} s and error rate < ${pct(ERROR_BUDGET)}.`,
  ];
}

function loadMarkdown(meta, r) {
  const o = r.overall;
  const notes = errorNotes(o.errors);
  return [
    `## Load test: ${users} concurrent users (${meta.date})`,
    '',
    ...setupLines(meta),
    `- ${users} users started over ${rampS} s, then measured for ${durationS} s.`,
    '',
    `**Result: ${r.pass ? 'Pass' : 'Fail'}**: ${o.requests} requests, throughput ${o.throughput.toFixed(1)} successful req/s, error rate ${pct(o.errorRate)}, p50 ${fmt(o.p50Ms)}, p95 ${fmt(o.p95Ms)}, p99 ${fmt(o.p99Ms)}.`,
    '',
    '| Action | Requests | Errors | p50 | p95 | p99 | Max |',
    '|---|---|---|---|---|---|---|',
    ...r.routes.map((x) => `| ${x.name} | ${x.requests} | ${pct(x.errorRate)} | ${fmt(x.p50Ms)} | ${fmt(x.p95Ms)} | ${fmt(x.p99Ms)} | ${fmt(x.maxMs)} |`),
    `| **All** | **${o.requests}** | **${pct(o.errorRate)}** | **${fmt(o.p50Ms)}** | **${fmt(o.p95Ms)}** | **${fmt(o.p99Ms)}** | **${fmt(o.maxMs)}** |`,
    '',
    ...(notes.length || !r.pass
      ? ['### Notes', '', ...notes.map((n) => `- ${n}`), ...(r.pass ? [] : [`- Slowest request id: ${r.slowestRequestId}; search the service logs for it.`]), '']
      : []),
  ].join('\n');
}

function stressMarkdown(meta, r) {
  const allErrors = {};
  for (const s of r.stages) for (const [code, n] of Object.entries(s.errors)) allErrors[code] = (allErrors[code] ?? 0) + n;
  const findings = [
    r.capacityUsers
      ? `Within the target up to **${r.capacityUsers} concurrent users**.`
      : `Already outside the target at ${r.stages[0].users} users.`,
    r.breaking
      ? `Breaks at **${r.breaking.users} users**: p95 ${fmt(r.breaking.p95Ms)}, error rate ${pct(r.breaking.errorRate)}; slowest action ${r.breaking.slowestRoute?.name ?? '–'} (p95 ${fmt(r.breaking.slowestRoute?.p95Ms ?? NaN)}).`
      : `Did not break up to ${r.stages.at(-1).users} users; run more stages to find the limit.`,
    ...(r.saturation ? [`Throughput stopped growing at ${r.saturation.users} users (${r.saturation.throughput.toFixed(1)} req/s): the system is saturated, and more users only wait longer.`] : []),
    ...(r.aborted ? [`Stopped early: more than ${pct(ABORT_ERROR_RATE)} of requests failed.`] : []),
  ];
  return [
    `## Stress test: ${stages.join(' → ')} users (${meta.date})`,
    '',
    ...setupLines(meta),
    `- ${stageS} s per stage; new users are started over the first seconds of their stage.`,
    '',
    '| Users | Requests | Throughput (successful) | Error rate | p50 | p95 | p99 | Within target |',
    '|---|---|---|---|---|---|---|---|',
    ...r.stages.map((s) => `| ${s.users} | ${s.requests} | ${s.throughput.toFixed(1)} req/s | ${pct(s.errorRate)} | ${fmt(s.p50Ms)} | ${fmt(s.p95Ms)} | ${fmt(s.p99Ms)} | ${s.withinTarget ? 'Yes' : 'No'} |`),
    '',
    '### Findings',
    '',
    ...findings.map((f) => `- ${f}`),
    ...errorNotes(allErrors).map((n) => `- ${n}`),
    '',
  ].join('\n');
}

// ---------- main ----------

const client = gatewayClient(gatewayUrl, await signIn());
const jobId = await prepare(client);
await ensureDraft(client, jobId);
const steps = journey(jobId);
for (const step of steps) await client.timed({ ...step, requestId: `load-warmup-${step.id}`, timeoutMs: REQUEST_TIMEOUT_MS });

const meta = { date: now(), gatewayUrl, machine: machineInfo(), jobId, mode, thinkMs };

if (mode === 'load') {
  console.log(`Load test: ${users} users (ramp ${rampS} s), ${durationS} s measured, think ${thinkMs / 1000} s, gateway ${gatewayUrl}\n`);
  const result = await loadTest(client, steps);
  const o = result.overall;
  console.log(`\n${pad('Action', 22)}${pad('Requests', 10)}${pad('Errors', 9)}${pad('p50', 10)}${pad('p95', 10)}${pad('p99', 10)}Max`);
  for (const x of [...result.routes, { name: 'All', ...o }]) {
    console.log(`${pad(x.name, 22)}${pad(x.requests, 10)}${pad(pct(x.errorRate), 9)}${pad(fmt(x.p50Ms), 10)}${pad(fmt(x.p95Ms), 10)}${pad(fmt(x.p99Ms), 10)}${fmt(x.maxMs)}`);
  }
  const errors = errorList(o.errors);
  console.log(`\n${o.throughput.toFixed(1)} successful req/s${errors ? `, errors: ${errors}` : ''}`);
  console.log(`${result.pass ? 'PASS' : 'FAIL'}: p95 ${fmt(o.p95Ms)} (target ${fmt(NORMAL_TARGET_MS)}), error rate ${pct(o.errorRate)} (target < ${pct(ERROR_BUDGET)})`);
  writeResults(args.out, 'load', { ...meta, users, rampS, durationS, ...result }, loadMarkdown(meta, result));
  process.exit(result.pass ? 0 : 1);
}

console.log(`Stress test: ${stages.join(' → ')} users, ${stageS} s per stage, think ${thinkMs / 1000} s, gateway ${gatewayUrl}\n`);
const result = await stressTest(client, steps);
console.log(`\n${pad('Users', 8)}${pad('Requests', 10)}${pad('OK/s', 9)}${pad('Errors', 9)}${pad('p50', 10)}${pad('p95', 10)}${pad('p99', 10)}Within target`);
for (const s of result.stages) {
  console.log(`${pad(s.users, 8)}${pad(s.requests, 10)}${pad(s.throughput.toFixed(1), 9)}${pad(pct(s.errorRate), 9)}${pad(fmt(s.p50Ms), 10)}${pad(fmt(s.p95Ms), 10)}${pad(fmt(s.p99Ms), 10)}${s.withinTarget ? 'yes' : 'NO'}`);
}
const md = stressMarkdown(meta, result);
console.log(`\n${md.slice(md.indexOf('### Findings') + '### Findings'.length).trim()}`);
writeResults(args.out, 'stress', { ...meta, stageS, ...result }, md);
