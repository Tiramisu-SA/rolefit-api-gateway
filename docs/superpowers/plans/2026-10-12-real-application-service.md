# Real Application Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route application submission through the gateway and switch the frontend's application features (submit, my applications, recruiter applicants, status change) from the browser mock to the real Application Service.

**Architecture:** The gateway's `/api/applications` allow-list gains `POST /` for seekers. The frontend's `application.ts` calls the gateway and maps the service's application shape to the existing frontend type; the recruiter applicants UI is restored from git stash `feb384e` and adapted.

**Tech Stack:** Gateway: TypeScript, Express 5, node:test. Frontend: Next.js 16, vitest.

**Spec:** `docs/superpowers/specs/2026-10-12-real-application-service-design.md`

## Global Constraints

- Do NOT modify any backend service. The Resume Preparation frontend mock stays.
- Gateway repo `/Users/nif/dev/SoftwareArchitecture/RoleFit/rolefit-api-gateway`, branch `main`. Frontend repo `/Users/nif/dev/SoftwareArchitecture/RoleFit/rolefit-frontend`, branch `feat/api-gateway`. Both checked out; stay on them.
- Application statuses (exact): `Submitted`, `Under review`, `Interview`, `Offer`, `Rejected`.
- Submit body: `{ jobId, coverLetter? }` only. Status body: `{ status, note? }` only (note trimmed, omitted when empty).
- Recruiter notes are NOT emailed (they are saved in the status history).
- Frontend: keep exported function names/signatures; UI changes only where listed.
- Never read or commit `.env*` (except tracked `.env.example`). Quote globs in zsh. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Gateway — POST /api/applications for seekers

Repo: gateway.

**Files:** Modify `src/routes/application.routes.ts`, `tests/applications.test.ts`, `README.md`.

- [ ] **Step 1: Tests first** (`tests/applications.test.ts`)

Add:

```ts
test('seeker submit is forwarded to POST /api/applications with body and verified identity', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/applications`, {
      method: 'POST',
      headers: as('seeker-token', { 'Content-Type': 'application/json', ...forged }),
      body: JSON.stringify({ jobId: 'job_1', coverLetter: 'Hello' }),
    });
    assert.equal(res.status, 201);
    const echo = (await res.json()) as Echo;
    assert.equal(echo.method, 'POST');
    assert.equal(echo.url, '/api/applications');
    assert.deepEqual(JSON.parse(echo.body!), { jobId: 'job_1', coverLetter: 'Hello' });
    assert.equal(echo.headers['x-user-id'], SEEKER);
    assert.equal(echo.headers['x-user-role'], 'seeker');
    assert.equal(echo.headers['x-company-id'], undefined);
    assert.equal(echo.headers.authorization, 'Bearer seeker-token');
  });
});

test('recruiters cannot submit applications', async () => {
  await withGateway(async (base) => {
    const res = await fetch(`${base}/api/applications`, { method: 'POST', headers: as('recruiter-token', { 'Content-Type': 'application/json' }), body: '{"jobId":"job_1"}' });
    assert.equal(res.status, 403);
    assert.equal((await errorOf(res)).code, 'FORBIDDEN');
  });
});
```

In the existing "unsupported routes are a gateway 404 and are not forwarded" test, replace the `POST /api/applications` request with `DELETE /api/applications/app_1` (still expecting 404 `ROUTE_NOT_FOUND`). The echo service answers POST with 201 (already in `tests/helpers.ts`).

- [ ] **Step 2:** Run `npm test` → the new tests FAIL (POST falls through to 404).

- [ ] **Step 3: Implement** — in `createApplicationRoutes` add as the first route:

```ts
  router.post('/', requireSeeker, proxy);
```
and update the doc comment: five endpoints (submit added); "submitting, which the service doesn't offer yet" wording removed; other paths are a gateway 404.

- [ ] **Step 4: README** — routes table: add row `` `POST /api/applications` (seekers) | Application Service | same path, body `{ jobId, coverLetter? }` ``; change the sentence "Other paths under `/api/applications` (for example submitting an application) are a gateway `404`." to "Other paths under `/api/applications` are a gateway `404`."; remove "in development" from the Application architecture line and services table.

- [ ] **Step 5:** `npm test && npm run typecheck` → all pass.

- [ ] **Step 6: Commit**

```bash
git add src tests README.md
git commit -m "feat: route application submission (POST /api/applications) for seekers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Frontend — real Application client

Repo: frontend.

**Files:** Rewrite `src/lib/api/application.ts`; create `src/lib/api/application.test.ts`; modify `src/lib/types.ts`, `src/lib/api/_store.ts`, `src/app/recruiter/dashboard/page.tsx`, `src/components/recruiter/jobs-table.tsx`; delete `src/lib/mock/applications.ts`.

**Interfaces produced:** `toApplication(raw): Application`; `submitApplication(jobId: string, coverLetter?: string): Promise<ApplicationView>`; `listMyApplications(): Promise<ApplicationView[]>`; `listApplicantsForJob(job: JobWithCompany): Promise<ApplicationView[]>`; `updateApplicationStatus(id: string, status: ApplicationStatus, note?: string): Promise<ApplicationView>`; `Application.matchSnapshot: MatchSnapshot | null`.

- [ ] **Step 1: Test first** — `src/lib/api/application.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as applications from "./application";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/supabase", () => ({ supabase: { auth: { getSession } } }));

const fetchMock = vi.fn();
const GW = "http://localhost:8080";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const protoJob = (id: string, status = "JOB_STATUS_OPEN") => ({
  id, recruiter_id: "u1", company_id: "co-acme-corp-7f3a9c", title: `Job ${id}`, status,
  created_at: "2026-10-01T00:00:00.000Z", updated_at: "2026-10-01T00:00:00.000Z",
});

const rawApp = (over: Record<string, unknown> = {}) => ({
  id: "app_1", jobId: "job_1", companyId: "co-acme-corp-7f3a9c", candidateId: "c1",
  candidate: { id: "c1", name: "Mai Srisuk", email: "mai@example.com" },
  jobSnapshot: { id: "job_1", title: "Job job_1", companyId: "co-acme-corp-7f3a9c" },
  resumeReference: { draftId: "draft_9", format: "company", approvedAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" },
  matchSnapshot: { score: 72, explanation: "Good fit", summary: "Good fit", capturedAt: "2026-10-02T00:00:00.000Z" },
  status: "Submitted", submittedAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
  history: [{ status: "Submitted", at: "2026-10-02T00:00:00.000Z", changedBy: "c1", note: null }],
  ...over,
});

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_GATEWAY_URL", GW);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  getSession.mockResolvedValue({ data: { session: { access_token: "test-token" } } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("toApplication", () => {
  it("maps the service shape to the frontend type", () => {
    expect(applications.toApplication(rawApp())).toEqual({
      id: "app_1", jobId: "job_1", candidateId: "c1",
      candidate: { id: "c1", name: "Mai Srisuk", initials: "MS", headline: "", email: "mai@example.com" },
      resumeDraftId: "draft_9", resumeFormat: "company", status: "Submitted",
      submittedAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
      matchSnapshot: { score: 72, summary: "Good fit", capturedAt: "2026-10-02T00:00:00.000Z" },
      history: [{ status: "Submitted", at: "2026-10-02T00:00:00.000Z" }],
    });
  });

  it("handles legacy rows without resume or match snapshots", () => {
    const app = applications.toApplication(rawApp({ resumeReference: null, matchSnapshot: null, history: [{ status: "Submitted", at: "x", changedBy: "c1", note: "hi" }] }));
    expect(app.matchSnapshot).toBeNull();
    expect(app.resumeDraftId).toBe("");
    expect(app.resumeFormat).toBe("personal");
    expect(app.history).toEqual([{ status: "Submitted", at: "x", note: "hi" }]);
  });
});

describe("application client", () => {
  it("submits through the gateway and returns the application with its job", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith(`${GW}/api/applications`) ? jsonResponse(201, { application: rawApp() }) : jsonResponse(200, { job: protoJob("job_1") }),
    );
    const view = await applications.submitApplication("job_1");
    const [url, init] = fetchMock.mock.calls[0];
    expect([url, init.method]).toEqual([`${GW}/api/applications`, "POST"]);
    expect(JSON.parse(init.body)).toEqual({ jobId: "job_1" });
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-token");
    expect(fetchMock.mock.calls[1][0]).toBe(`${GW}/api/jobs/job_1`);
    expect(view).toMatchObject({ id: "app_1", job: { id: "job_1" } });
  });

  it("keeps the service's error code and message when submitting fails", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(409, { error: { code: "ALREADY_APPLIED", message: "You've already applied to this job" } }));
    await expect(applications.submitApplication("job_1")).rejects.toMatchObject({ code: "ALREADY_APPLIED", status: 409, message: "You've already applied to this job" });
  });

  it("lists my applications joined with their jobs, leaving out jobs that no longer exist", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === `${GW}/api/applications/mine`) return jsonResponse(200, { applications: [rawApp(), rawApp({ id: "app_2", jobId: "job_gone" })] });
      if (url.startsWith(`${GW}/api/jobs?`) || url === `${GW}/api/jobs`) return jsonResponse(200, { jobs: [protoJob("job_1")] });
      return jsonResponse(404, { error: { code: "NOT_FOUND", message: "Job not found" } });
    });
    const mine = await applications.listMyApplications();
    expect(mine.map((a) => a.id)).toEqual(["app_1"]);
    expect(mine[0].job.id).toBe("job_1");
  });

  it("lists a job's applicants best match first, unscored last", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(200, {
        applications: [
          rawApp({ id: "low", matchSnapshot: { score: 40, summary: "", capturedAt: "x" } }),
          rawApp({ id: "none", matchSnapshot: null }),
          rawApp({ id: "high", matchSnapshot: { score: 90, summary: "", capturedAt: "x" } }),
        ],
      }),
    );
    const job = { id: "job_1" } as Parameters<typeof applications.listApplicantsForJob>[0];
    const list = await applications.listApplicantsForJob(job);
    expect(fetchMock.mock.calls[0][0]).toBe(`${GW}/api/applications?jobId=job_1`);
    expect(list.map((a) => a.id)).toEqual(["high", "low", "none"]);
    expect(list[0].job).toBe(job);
  });

  it("updates a status with a trimmed note and returns it with the recruiter's job", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/api/applications/")
        ? jsonResponse(200, { application: rawApp({ status: "Interview" }), notificationQueued: true })
        : jsonResponse(200, { job: protoJob("job_1") }),
    );
    const view = await applications.updateApplicationStatus("app_1", "Interview", "  See you Monday  ");
    const [url, init] = fetchMock.mock.calls[0];
    expect([url, init.method]).toEqual([`${GW}/api/applications/app_1/status`, "PATCH"]);
    expect(JSON.parse(init.body)).toEqual({ status: "Interview", note: "See you Monday" });
    expect(fetchMock.mock.calls[1][0]).toBe(`${GW}/api/jobs/mine/job_1`);
    expect(view.status).toBe("Interview");

    await applications.updateApplicationStatus("app_1", "Offer", "   ");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({ status: "Offer" });
  });
});
```

- [ ] **Step 2:** `npx vitest run src/lib/api/application.test.ts` → FAIL (mock implementation; `toApplication` missing).

- [ ] **Step 3: Rewrite `src/lib/api/application.ts`**

```ts
import { profileInitials } from "@/lib/profile";
import type { Application, ApplicationStatus, ApplicationView, JobWithCompany, MatchSnapshot } from "@/lib/types";
import { ApiError } from "./errors";
import { gatewayRequest } from "./gateway";
import * as jobPosting from "./job-posting";

// REST client for the Application Service, reached through the API Gateway
// (/api/applications/*, same paths upstream). Submitting stores the approved
// resume and a match snapshot on the server; a status change queues the email
// that the Notification Service sends.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Msg = Record<string, any>;

const request = <T>(method: string, path: string, init: { json?: unknown; query?: URLSearchParams } = {}) =>
  gatewayRequest<T>(method, `/api/applications${path}`, { ...init, serviceName: "application service" });

const byUpdated = (a: Application, b: Application) => b.updatedAt.localeCompare(a.updatedAt);
const scoreOf = (a: Application) => a.matchSnapshot?.score ?? -1;

function toMatchSnapshot(raw: Msg | null | undefined): MatchSnapshot | null {
  if (!raw || typeof raw.score !== "number") return null;
  return {
    score: raw.score,
    summary: typeof raw.summary === "string" ? raw.summary : (raw.explanation ?? ""),
    capturedAt: raw.capturedAt ?? raw.computedAt ?? "",
  };
}

/** The service's application → the frontend type. The service keeps only the candidate's name and email. */
export function toApplication(raw: Msg): Application {
  const name: string = raw.candidate?.name ?? "";
  return {
    id: raw.id,
    jobId: raw.jobId,
    candidateId: raw.candidateId,
    candidate: { id: raw.candidate?.id ?? raw.candidateId, name, initials: profileInitials(name), headline: "", email: raw.candidate?.email ?? "" },
    resumeDraftId: raw.resumeReference?.draftId ?? "",
    resumeFormat: raw.resumeReference?.format === "company" ? "company" : "personal",
    status: raw.status,
    submittedAt: raw.submittedAt,
    updatedAt: raw.updatedAt,
    matchSnapshot: toMatchSnapshot(raw.matchSnapshot),
    history: (raw.history ?? []).map((h: Msg) => ({ status: h.status, at: h.at, ...(h.note ? { note: h.note } : {}) })),
  };
}

/**
 * Loads the jobs the seeker's applications refer to: one call for open jobs,
 * then one per closed job. Jobs that no longer exist are left out.
 */
async function jobsFor(ids: string[]): Promise<Map<string, JobWithCompany>> {
  const byId = new Map((await jobPosting.listOpenJobs()).map((j) => [j.id, j]));
  for (const id of ids) {
    if (byId.has(id)) continue;
    try {
      byId.set(id, await jobPosting.getJob(id));
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "NOT_FOUND")) throw e;
    }
  }
  return byId;
}

/** Applies to an open job with the approved resume; the service snapshots the resume and the match. */
export async function submitApplication(jobId: string, coverLetter?: string): Promise<ApplicationView> {
  const body = coverLetter?.trim() ? { jobId, coverLetter: coverLetter.trim() } : { jobId };
  const { application } = await request<{ application: Msg }>("POST", "", { json: body });
  return { ...toApplication(application), job: await jobPosting.getJob(jobId) };
}

export async function listMyApplications(): Promise<ApplicationView[]> {
  const { applications } = await request<{ applications: Msg[] }>("GET", "/mine");
  const mine = applications.map(toApplication);
  const jobs = await jobsFor([...new Set(mine.map((a) => a.jobId))]);
  return mine
    .filter((a) => jobs.has(a.jobId))
    .sort(byUpdated)
    .map((a) => ({ ...a, job: jobs.get(a.jobId)! }));
}

/** Applicants for one of the recruiter's jobs (the caller already has the job), best match first. */
export async function listApplicantsForJob(job: JobWithCompany): Promise<ApplicationView[]> {
  const { applications } = await request<{ applications: Msg[] }>("GET", "", { query: new URLSearchParams({ jobId: job.id }) });
  return applications
    .map(toApplication)
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .map((a) => ({ ...a, job }));
}

/** Changes the status; the Application Service queues the candidate's notification email. */
export async function updateApplicationStatus(id: string, status: ApplicationStatus, note?: string): Promise<ApplicationView> {
  const body = note?.trim() ? { status, note: note.trim() } : { status };
  const { application } = await request<{ application: Msg }>("PATCH", `/${encodeURIComponent(id)}/status`, { json: body });
  const updated = toApplication(application);
  return { ...updated, job: await jobPosting.getMyJob(updated.jobId) };
}
```

- [ ] **Step 4: Types** — in `src/lib/types.ts`: rename the section comment `// --- Application (mock) ---…` to `// --- Application Service ---…` (keep the dash style) and change `matchSnapshot: MatchSnapshot;` to `matchSnapshot: MatchSnapshot | null;` with the doc comment `/** Captured at submission; null for applications stored without one. */` above it.

- [ ] **Step 5: Consumers of a nullable score**
  - `src/app/recruiter/dashboard/page.tsx`: `<MatchBadge score={app.matchSnapshot.score} />` → `{app.matchSnapshot && <MatchBadge score={app.matchSnapshot.score} />}`.
  - `src/components/recruiter/jobs-table.tsx` in `loadJobRows`: replace the `avgMatch` line with

```ts
        avgMatch: average(apps.flatMap((a) => (a.matchSnapshot ? [a.matchSnapshot.score] : []))),
```
and add above `loadJobRows`:

```ts
/** Rounded mean, or null for none (applications without a match snapshot are left out). */
const average = (scores: number[]): number | null =>
  scores.length ? Math.round(scores.reduce((s, n) => s + n, 0) / scores.length) : null;
```

- [ ] **Step 6: Remove the application mock**
  - Delete `src/lib/mock/applications.ts` (`git rm`; remove `src/lib/mock/` if empty).
  - `src/lib/api/_store.ts`: remove the `applications` import/field and the re-export; add `export const SEEKER_ID = "me";` with comment `/** The one mock seeker in this browser (used by the Resume Preparation mock). */`; `Store` only has `resumeDrafts`; `store = structuredClone({ resumeDrafts: [] as ResumeDraft[] })` (or typed equivalent); update the header comment to say only Resume Preparation is still mocked.
  - `grep -rnE "mock/applications|store\.applications" src scripts` → no results.

- [ ] **Step 7:** `npm test && npm run lint && npx tsc --noEmit -p tsconfig.json` → all pass (fix any other compile error caused by the nullable type with the same null-guard pattern and list it in the report).

- [ ] **Step 8: Commit**

```bash
git add -A src
git commit -m "feat: use the real Application Service through the gateway

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — restore the recruiter applicants UI, smoke test, README

Repo: frontend.

**Files:** Create (from stash) `src/app/recruiter/jobs/[id]/applicants/page.tsx`, `src/components/recruiter/applicant-list.tsx`, `src/components/recruiter/applicant-detail.tsx`; modify `src/components/recruiter/jobs-table.tsx`, `scripts/e2e-smoke.ts`, `README.md`.

**Interfaces consumed:** Task 2's `listApplicantsForJob(job)`, `updateApplicationStatus(id, status, note?)`, nullable `matchSnapshot`; `jobPosting.getMyJob(id)`.

- [ ] **Step 1: Restore the files exactly from the stash**

```bash
git show 'feb384e:src/app/recruiter/jobs/[id]/applicants/page.tsx' > 'src/app/recruiter/jobs/[id]/applicants/page.tsx'   # mkdir -p the folder first
git show 'feb384e:src/components/recruiter/applicant-list.tsx' > src/components/recruiter/applicant-list.tsx
git show 'feb384e:src/components/recruiter/applicant-detail.tsx' > src/components/recruiter/applicant-detail.tsx
```

- [ ] **Step 2: Adapt `page.tsx`**
  - Replace the two loaders (`jobState`, `appsState`) with one:

```tsx
  const state = useAsync(async () => {
    const job = await jobPosting.getMyJob(id);
    return { job, applications: await applicationService.listApplicantsForJob(job) };
  }, [id]);
  const job = state.data?.job;
  const applications = useMemo(() => state.data?.applications ?? [], [state.data]);
```
  (import `useMemo`). Replace every `appsState.data` with `state.data?.applications`, `appsState.data.length` / `.some(...)` accordingly.
  - `handleUpdated`: `if (state.data) state.setData({ ...state.data, applications: applications.map((a) => (a.id === updated.id ? updated : a)) });`
  - `reload` → `state.reload()` (remove the `reload()` helper or make it call `state.reload`); `loading` = `state.loading`; `error` = `state.error`; delete the old `const job = jobState.data;`.
  - Deadline: `job.deadline ? … formatDate(job.deadline)` → use `job.applicationSettings.applicationDeadline` in both places.
  - Everything else (layout, sheet, deep link) unchanged.

- [ ] **Step 3: Adapt `applicant-list.tsx`** — replace

```tsx
            const tier = matchTier(a.matchSnapshot.score);
```
with
```tsx
            const score = a.matchSnapshot?.score;
```
and the score span with
```tsx
                <span className={cn("w-12 shrink-0 text-right text-[15px] font-extrabold", score === undefined ? "text-muted-foreground" : MATCH_TIER_CLASS[matchTier(score)].text)}>
                  {score === undefined ? "–" : `${score}%`}
                </span>
```
Render `a.candidate.headline` only when non-empty: `{a.candidate.headline && <span className="truncate text-[13px] text-muted-foreground">{a.candidate.headline}</span>}`.

- [ ] **Step 4: Adapt `applicant-detail.tsx`**
  - Remove `const tier = matchTier(application.matchSnapshot.score);`. Wrap the whole "Match snapshot" block in `{application.matchSnapshot ? ( …existing block, using const snapshot = application.matchSnapshot inside via an IIFE-free approach: replace application.matchSnapshot.X with snapshot.X and compute the tier class with MATCH_TIER_CLASS[matchTier(snapshot.score)] … ) : (<p className="rounded-2xl bg-muted/40 p-4 text-sm text-muted-foreground">No match snapshot was stored for this application.</p>)}` — implement by declaring `const snapshot = application.matchSnapshot;` near the top and using `snapshot` in the block.
  - Headline line: render only when non-empty.
  - Note field copy: label `Note <span …>(optional)</span>` (keep the span styling) and placeholder `"Saved in the status history. It is not included in the email."`.
  - Success toast: `` `Status updated. ${firstName} will get an email about the change.` ``.
  - Keep the resume button (`toast.info("Resume viewer is not connected yet")`) and the rest unchanged.

- [ ] **Step 5: Jobs table link** — in `jobs-table.tsx` dropdown, add before "Edit":

```tsx
                      <DropdownMenuItem render={<Link href={`/recruiter/jobs/${job.id}/applicants`} />}>Applicants</DropdownMenuItem>
```

- [ ] **Step 6: Smoke test** — in `scripts/e2e-smoke.ts`, add these steps after the "discovery: unknown job is 404" step and before the cleanup step (the seeker is signed in at that point; the Application Service must run with its resume dev fallback):

```ts
  // --- Application Service (submission + status, through the gateway) ---
  let applicationId = "";
  await step("applications: seeker applies and sees the application", async () => {
    const app = await applications.submitApplication(jobId);
    applicationId = app.id;
    expect(app.status === "Submitted" && app.jobId === jobId, JSON.stringify(app));
    expect((await applications.listMyApplications()).some((a) => a.id === applicationId), "missing from my applications");
    await rejects(applications.submitApplication(jobId), "ALREADY_APPLIED");
  });
  await step("applications: recruiter sees the applicant and updates the status", async () => {
    await signInAs("RECRUITER");
    const job = await jobs.getMyJob(jobId);
    const list = await applications.listApplicantsForJob(job);
    expect(list.some((a) => a.id === applicationId), "applicant missing for recruiter");
    const updated = await applications.updateApplicationStatus(applicationId, "Under review", "E2E review");
    expect(updated.status === "Under review" && updated.history.length >= 2, JSON.stringify(updated.history));
    await signInAs("SEEKER");
  });
```
and import the module next to the others in `main()`: `const applications = await import("../src/lib/api/application");`. Update the header comment's list of required services to include the Application Service (`:3004`, with `APP_ENV=development RESUME_PREPARATION_MODE=fallback`).

- [ ] **Step 7: README** — replace the sentences about Application being a mock with: the Application Service is real (submit, my applications, recruiter applicants and status changes through `/api/applications/*`; a status change emails the candidate via the Notification Service). Resume Preparation is still a browser mock, so run the Application Service locally with `APP_ENV=development` and `RESUME_PREPARATION_MODE=fallback` until the resume page is integrated. Add the Application Service to the e2e row's requirements.

- [ ] **Step 8:** `npm test && npm run lint && npx tsc --noEmit -p tsconfig.json && npm run build` → all pass.

- [ ] **Step 9: Commit**

```bash
git add -A src scripts README.md
git commit -m "feat: restore the recruiter applicants page with real status changes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Live verification (controller)

- [ ] Clone/run the Application Service locally per its README (`docker compose up -d postgres rabbitmq mailpit`, migrate, `APP_ENV=development RESUME_PREPARATION_MODE=fallback npm run dev` on :3004) plus the Notification Service if needed for email; or ask the user to start them.
- [ ] Run the frontend e2e smoke test → ALL PASSED; check Mailpit (`http://localhost:8025`) for the "Under review" email.
