# Real Application Service in gateway + frontend — Design

Date: 2026-10-12 · Status: approved · Builds on `2026-10-11-application-service-routes-design.md`

## Goal

The Application Service (owner Pun, `Tiramisu-SA/rolefit-application-service`, `:3004`) now accepts
submissions. Route submission through the gateway and switch the frontend's application features from the
browser mock to the real service: seekers apply and see their applications; recruiters list applicants and
change status, which makes the Notification Service email the candidate.

## Decisions

1. **Gateway + frontend only.** No service code changes. Service-to-service gRPC (Job Discovery
   `GetMatchResult`, verified email header) is a later step owned by the services.
2. **Resume flow stays a frontend mock.** Real submission needs an approved resume from Resume Preparation,
   so locally the Application Service runs with its development fallback
   (`APP_ENV=development`, `RESUME_PREPARATION_MODE=fallback`) until the resume page is integrated.
3. **Recruiter applicants UI restored** from the user's git stash `feb384e` (2026-09-28) and adapted.

## Upstream contract (Application Service openapi.yaml)

- `POST /api/applications` body `{ jobId, coverLetter? }` (no extra fields) → `201 { application }`. Seeker only;
  needs `X-User-Id`, `X-User-Role: seeker` and the forwarded `Authorization` (it calls Job Posting / Resume
  Preparation over gRPC and Candidate Profile / Job Discovery over REST with it). 409 codes: `ALREADY_APPLIED`,
  `JOB_NOT_OPEN`, `APPLICATION_DEADLINE_PASSED`, `COVER_LETTER_REQUIRED`, `RESUME_DRAFT_NOT_FOUND`,
  `RESUME_NOT_APPROVED`, `PROFILE_REQUIRED`, `PROFILE_INCOMPLETE`.
- `GET /api/applications/mine`, `GET /api/applications?jobId=`, `GET /api/applications/:id`,
  `PATCH /api/applications/:id/status` `{ status, note? }` → `{ application, notificationQueued }`.
- Application: `id, jobId, companyId, candidateId, candidate{id,name,email}, jobSnapshot, resumeReference
  {draftId, format, approvedAt, updatedAt}|null, matchSnapshot (MatchResult + summary + capturedAt)|null, status,
  submittedAt, updatedAt, history[{status, at, changedBy, note|null}], resumeSnapshot, coverLetter`.
- Recruiter notes are stored in history but **not** sent in the notification email.

## Gateway

Add `POST /api/applications` (seeker only) to the existing allow-list, proxied to `POST /api/applications`
upstream with the JSON body streamed. Other unsupported methods/paths stay a gateway 404. README route table updated.

## Frontend

- `src/lib/api/application.ts`: all functions call the gateway (`/api/applications…`); same exported names and
  signatures (`submitApplication(jobId)`, `listMyApplications()`, `listApplicantsForJob(job)`,
  `updateApplicationStatus(id, status, note?)`). A `toApplication(raw)` mapper converts to the frontend type:
  initials from the name, headline `""`, `resumeDraftId`/`resumeFormat` from `resumeReference`, `matchSnapshot`
  `{ score, summary, capturedAt }` or `null`, history notes `null` → absent. Seekers' application jobs are joined
  as before; recruiters get the job they passed (or `getMyJob` after a status change).
- `Application.matchSnapshot` becomes `MatchSnapshot | null`; the recruiter dashboard badge and jobs-table average
  skip applications without a score.
- Mock removal: `src/lib/mock/applications.ts` deleted; `_store.ts` keeps only the resume-draft mock (`SEEKER_ID`
  moves into it).
- Restored recruiter UI: `src/app/recruiter/jobs/[id]/applicants/page.tsx`, `src/components/recruiter/applicant-list.tsx`,
  `src/components/recruiter/applicant-detail.tsx`, adapted to current APIs (job via `getMyJob`, deadline from
  `applicationSettings.applicationDeadline`, null match snapshots, note copy says it is saved in history and not
  emailed). Jobs table gets an "Applicants" menu item; the dashboard's existing link now resolves.
- `scripts/e2e-smoke.ts`: seeker applies to the e2e job, sees it in their list; recruiter sees the applicant and
  moves it to "Under review".
- README: Application Service is real; local run needs the Application Service with the resume dev fallback.

## Testing

Gateway: seeker POST forwarded with body and identity; recruiter POST refused; another unsupported route 404.
Frontend: unit tests for the client (request shapes, mapping incl. null snapshot, joins, sorting, errors); lint,
tsc, build. Live: e2e smoke with the Application Service running (dev resume fallback) and Mailpit showing the email.

## Out of scope

Resume Preparation integration, Job Discovery gRPC server, X-User-Email header, any service code change.
