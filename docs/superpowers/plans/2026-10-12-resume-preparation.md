# Resume Preparation Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Resume Preparation through the gateway and replace the frontend's resume mock with the real service, so real application submission (which reads the approved resume over gRPC) works end to end.

**Why (spec in brief):** The Application Service's submit calls Resume Preparation `GetApprovedResume`; its development fallback only covers two built-in demo users, so real accounts need the real resume flow. Resume Preparation (`Tiramisu-SA/rolefit-resume-preparation-service`, REST `:3006`, gRPC `:50053`) documents gateway mapping `/api/resumes/*` → its `/api/*`, verifies the Supabase token itself (so `Authorization` must be forwarded), and accepts seekers only. Its REST contract matches the frontend mock one to one:

| Service route | Gateway route | Frontend function |
|---|---|---|
| `POST /api/drafts/:jobId/generate` → 201 draft | `POST /api/resumes/drafts/:jobId/generate` | `generateTailoredResume(jobId)` |
| `GET /api/drafts/:jobId` → draft, 404 `RESUME_DRAFT_NOT_FOUND` | `GET /api/resumes/drafts/:jobId` | `getResumeDraft(jobId)` → `null` on that 404 |
| `PUT /api/drafts/:jobId/sections` body `{ sections }` | `PUT /api/resumes/drafts/:jobId/sections` | `editResumeDraft(jobId, sections)` |
| `PUT /api/drafts/:jobId/format` body `{ format }` | `PUT /api/resumes/drafts/:jobId/format` | `selectResumeFormat(jobId, format)` |
| `POST /api/drafts/:jobId/approve` | `POST /api/resumes/drafts/:jobId/approve` | `approveResume(jobId)` |
| `GET /api/drafts/:jobId/approved` | `GET /api/resumes/drafts/:jobId/approved` | `getApprovedResume(jobId)` |

Responses are the draft object directly (same shape as the frontend `ResumeDraft`, plus `approvedAt?`, `generatedAt`). Errors use `{ error: { code, message, details? } }`.

## Global Constraints

- Do NOT modify any backend service.
- Gateway repo branch `main`; frontend repo branch `feat/api-gateway` (both checked out).
- Gateway env: `RESUME_PREPARATION_SERVICE_URL=http://localhost:3006` (required).
- Frontend: keep the six exported resume function names/signatures; no UI changes.
- Never read or commit `.env*`. Quote globs in zsh. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Gateway — /api/resumes for seekers

Repo `/Users/nif/dev/SoftwareArchitecture/RoleFit/rolefit-api-gateway`.

**Files:** `src/app.ts`, `src/server.ts`, `src/config/env.ts`, `.env.example`, `README.md`, `tests/app.test.ts` or new `tests/resumes.test.ts`, `tests/env.test.ts`.

- [ ] **Step 1: Tests first.** Create `tests/resumes.test.ts` (same style as `tests/applications.test.ts`: an `echoService('resume-preparation')` downstream via `listen`, `createApp({...})` with all deps incl. `resumePreparationUrl`), covering:
  - seeker `POST /api/resumes/drafts/job_1/generate` → echo `url === '/api/drafts/job_1/generate'`, method POST, `authorization === 'Bearer seeker-token'`, `x-user-id === SEEKER`, `x-user-role === 'seeker'`;
  - seeker `PUT /api/resumes/drafts/job_1/sections` with JSON body → body preserved;
  - recruiter `GET /api/resumes/drafts/job_1` → 403 `FORBIDDEN`;
  - no token → 401 `MISSING_TOKEN`;
  - service down (`resumePreparationUrl: 'http://127.0.0.1:1'`) → 503 `{ code: 'SERVICE_UNAVAILABLE', message: 'The resume preparation service is unavailable. Please try again.' }`.
  In `tests/env.test.ts` add `RESUME_PREPARATION_SERVICE_URL: 'http://localhost:3006'` to `valid`, assert `config.resumePreparationUrl`, and add `'RESUME_PREPARATION_SERVICE_URL is required'` to the missing-variables test. Add `resumePreparationUrl: 'http://127.0.0.1:1'` to every other `createApp({...})` call in tests.
- [ ] **Step 2:** `npm test` → new tests FAIL.
- [ ] **Step 3: Implement.**
  - `src/config/env.ts`: `resumePreparationUrl: string` (doc `/** Resume Preparation Service REST base URL, no trailing slash. */`) = `httpUrl('RESUME_PREPARATION_SERVICE_URL')`.
  - `src/app.ts`: `AppDependencies.resumePreparationUrl: string`; import `requireSeeker`; mount after `/api/applications`:
    ```ts
    app.use('/api/resumes', requireSeeker, createServiceProxy(deps.resumePreparationUrl, 'resume preparation'));
    ```
  - `src/server.ts`: pass `resumePreparationUrl: config.resumePreparationUrl` and log `` `  /api/resumes/*      → ${config.resumePreparationUrl}/api/*` ``.
  - `.env.example`: after `APPLICATION_SERVICE_URL`, add `RESUME_PREPARATION_SERVICE_URL=http://localhost:3006` with a one-line comment.
  - `README.md`: architecture line `├─ HTTP ─▶ Resume Preparation Service (:3006)`; routes row `` `/api/resumes/*` (seekers) | Resume Preparation Service | `/api/*`, e.g. `/api/resumes/drafts/:jobId/generate` → `/api/drafts/:jobId/generate` ``; services table row `Resume Preparation | npm run dev in rolefit-resume-preparation-service | REST 3006, gRPC 50053`; env table row; security note ports add 3006 (Resume Preparation verifies the token itself).
- [ ] **Step 4:** `npm test && npm run typecheck` → pass.
- [ ] **Step 5: Commit** `feat: route Resume Preparation (/api/resumes/*) for seekers`.

---

### Task 2: Frontend — real Resume Preparation client

Repo `/Users/nif/dev/SoftwareArchitecture/RoleFit/rolefit-frontend`.

**Files:** rewrite `src/lib/api/resume-preparation.ts`; create `src/lib/api/resume-preparation.test.ts`; delete `src/lib/api/_store.ts` (no other users after this); modify `README.md`, `scripts/e2e-smoke.ts`.

- [ ] **Step 1: Test first** `src/lib/api/resume-preparation.test.ts` (same mocking pattern as `application.test.ts`: `vi.hoisted` supabase `getSession`, `fetchMock` with `mockImplementation`, `GW = "http://localhost:8080"`). A draft fixture: `{ id: "d1", jobId: "job_1", candidateId: "c1", format: "personal", sections: [{ id: "s1", kind: "summary", title: "Summary", bullets: [{ id: "b1", text: "Hi", tailored: false }], emphasized: false, included: true }], approved: false, generatedAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z" }`. Tests:
  - `generateTailoredResume("job 1")` → `POST ${GW}/api/resumes/drafts/job%201/generate`, Bearer token sent, returns the draft;
  - `getResumeDraft("job_1")` → GET; returns draft; on 404 `{ error: { code: "RESUME_DRAFT_NOT_FOUND", … } }` returns `null`; other errors (e.g. 503) reject with their code;
  - `editResumeDraft("job_1", sections)` → `PUT …/sections` body `{ sections }`;
  - `selectResumeFormat("job_1", "company")` → `PUT …/format` body `{ format: "company" }`;
  - `approveResume("job_1")` → `POST …/approve`;
  - `getApprovedResume("job_1")` → `GET …/approved`; a 409 `RESUME_NOT_APPROVED` rejects with that code.
- [ ] **Step 2:** run it → FAIL.
- [ ] **Step 3: Rewrite `src/lib/api/resume-preparation.ts`:**

```ts
import type { ResumeDraft, ResumeFormat, ResumeSection } from "@/lib/types";
import { ApiError } from "./errors";
import { gatewayRequest } from "./gateway";

// REST client for the Resume Preparation Service, reached through the API
// Gateway (/api/resumes/* → the service's /api/*). The service builds a resume
// for one job from the seeker's verified profile; the Application Service reads
// the approved version when the seeker applies.

const request = <T>(method: string, jobId: string, action = "", json?: unknown) =>
  gatewayRequest<T>(method, `/api/resumes/drafts/${encodeURIComponent(jobId)}${action}`, {
    ...(json !== undefined ? { json } : {}),
    serviceName: "resume preparation service",
  });

export const generateTailoredResume = (jobId: string) => request<ResumeDraft>("POST", jobId, "/generate");

/** The seeker's draft for this job, or null when there is none yet. */
export async function getResumeDraft(jobId: string): Promise<ResumeDraft | null> {
  try {
    return await request<ResumeDraft>("GET", jobId);
  } catch (e) {
    if (e instanceof ApiError && e.code === "RESUME_DRAFT_NOT_FOUND") return null;
    throw e;
  }
}

/** Sends every section back; only `included` and bullet `text` may change. Clears approval. */
export const editResumeDraft = (jobId: string, sections: ResumeSection[]) => request<ResumeDraft>("PUT", jobId, "/sections", { sections });

export const selectResumeFormat = (jobId: string, format: ResumeFormat) => request<ResumeDraft>("PUT", jobId, "/format", { format });

export const approveResume = (jobId: string) => request<ResumeDraft>("POST", jobId, "/approve");

export const getApprovedResume = (jobId: string) => request<ResumeDraft>("GET", jobId, "/approved");
```
  Check `src/lib/types.ts` `ResumeDraft`; if the extra service fields matter, leave the type unchanged (extra JSON fields are harmless). Remove now-unused helpers/imports (the old `buildSections` etc. go away with the mock).
- [ ] **Step 4: Remove the mock store.** `git rm src/lib/api/_store.ts`; `grep -rn "_store" src scripts` → nothing.
- [ ] **Step 5: README + smoke corrections.**
  - README: replace the paragraph that says Resume Preparation is a browser mock and that the Application Service must run with `RESUME_PREPARATION_MODE=fallback` with: Resume Preparation is real through `/api/resumes/*` (the gateway forwards the token; the service verifies it), and Application submission reads the approved resume from it. Add `/api/resumes/*` → Resume Preparation Service to the gateway-path table. Remove the "resume flow is still a browser mock" known limitation (keep the cover-letter one).
  - `scripts/e2e-smoke.ts`: header comment — required services now include Resume Preparation (`:3006` REST / `:50053` gRPC) and the Application Service in its normal live mode (remove the `RESUME_PREPARATION_MODE=fallback` note). Import `const resumes = await import("../src/lib/api/resume-preparation");` in `main()`. In step "applications: seeker applies and sees the application", before `submitApplication`, add:
    ```ts
    const draft = await resumes.generateTailoredResume(jobId);
    expect(draft.jobId === jobId && draft.sections.length > 0, JSON.stringify(draft));
    expect((await resumes.getResumeDraft(jobId))?.id === draft.id, "draft not readable");
    await rejects(resumes.getApprovedResume(jobId), "RESUME_NOT_APPROVED");
    const approved = await resumes.approveResume(jobId);
    expect(approved.approved, "draft not approved");
    ```
    and rename the step to "applications: seeker tailors and approves a resume, applies and sees the application".
- [ ] **Step 6:** `npm test && npm run lint && npx tsc --noEmit -p tsconfig.json && npm run build` → pass.
- [ ] **Step 7: Commit** `feat: use the real Resume Preparation Service through the gateway`.
