# RoleFit API Gateway

The single public backend entry point for the RoleFit web frontend. It verifies the user's
Supabase access token, then routes the request to the right microservice. It holds no business logic.

## Architecture

```
Frontend ──Authorization: Bearer <Supabase JWT>──▶ API Gateway (:8080)
                                                     ├─ HTTP ─▶ Candidate Profile Service (:3001)
                                                     ├─ HTTP ─▶ Job Discovery Service     (:3002)
                                                     ├─ HTTP ─▶ Application Service       (:3004)
                                                     ├─ HTTP ─▶ Resume Preparation Service (:3006)
                                                     └─ gRPC ─▶ Job Posting Service       (:50052)
```

For every `/api/*` request the gateway:

1. verifies the Supabase JWT (`supabase.auth.getClaims()`), returning `401` if it is missing, invalid or expired;
2. sets `X-User-Id` (token `sub`), `X-User-Role` (`app_metadata.role`) and, for recruiters, `X-Company-Id`
   (`app_metadata.company_id`, set by the Supabase signup trigger), replacing any client-sent values, and keeps
   `Authorization`. Job Posting receives the same user and company as gRPC metadata. Recruiter routes refuse a
   token without a company with `403 NO_COMPANY`;
3. forwards the request and returns the service's status and body unchanged.

## Services and routes

| Gateway route | Service | Upstream |
| --- | --- | --- |
| `GET /health` | gateway (no auth) | – |
| `/api/candidates/*` | Candidate Profile Service | `/api/*`, e.g. `/api/candidates/profiles/me` → `/api/profiles/me` |
| `/api/discovery/*` | Job Discovery Service | `/api/*`, e.g. `/api/discovery/recommendations` → `/api/recommendations` |
| `/api/resumes/*` (seekers) | Resume Preparation Service | `/api/*`, e.g. `/api/resumes/drafts/:jobId/generate` → `/api/drafts/:jobId/generate` |
| `POST /api/applications` (seekers) | Application Service | same path, body `{ jobId, coverLetter? }` |
| `GET /api/applications/mine` (seekers) | Application Service | same path |
| `GET /api/applications?jobId=` (recruiters) | Application Service | same path |
| `GET /api/applications/:applicationId` (seeker or recruiter) | Application Service | same path |
| `PATCH /api/applications/:applicationId/status` (recruiters) | Application Service | same path |
| `GET /api/jobs`, `GET /api/jobs/:jobId` | Job Posting Service | gRPC `ListJobs` (open jobs) / `GetJob` |
| `/api/jobs/mine/*` (recruiters only) | Job Posting Service | gRPC `ListJobs`, `CreateJob`, `GetJob`, `UpdateJob`, `DeleteJob`, `PublishJob`, `CloseJob`, `ReopenJob`, `Get/Attach/DeleteResumeTemplate` |

Other paths under `/api/applications` are a gateway `404`.

The Job Posting Service only speaks gRPC, so the gateway translates these REST calls to gRPC. Bodies and
responses are the proto messages as JSON (snake_case, enum names such as `JOB_STATUS_OPEN`), unchanged.

| Recruiter route | gRPC |
| --- | --- |
| `GET /api/jobs/mine?status=JOB_STATUS_DRAFT&query=` | `ListJobs` for the recruiter's company |
| `GET /api/jobs/mine/company` | – (returns `{ "companyId": …, "companyName": … }` from the token) |
| `POST /api/jobs/mine` (body: `JobInput`) | `CreateJob` |
| `GET / PUT / DELETE /api/jobs/mine/:jobId` | `GetJob` / `UpdateJob` / `DeleteJob` |
| `POST /api/jobs/mine/:jobId/publish` · `close` · `reopen` | `PublishJob` · `CloseJob` · `ReopenJob` |
| `GET / PUT / DELETE /api/jobs/mine/:jobId/resume-template` | `GetResumeTemplate` / `AttachResumeTemplate` (raw body, `Content-Type`, `X-File-Name`) / `DeleteResumeTemplate` |

## Local setup

Requires Node 20+ and the services running locally. Routes to a service that isn't running return `503`.

```bash
npm install
cp .env.example .env   # then fill in SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY
npm run dev            # or: npm run build && npm start
```

The gateway listens on `http://localhost:8080`. Start the services first:

| Service | Start | Port |
| --- | --- | --- |
| Candidate Profile | `npm run dev` in `rolefit-candidate-profile-service` | REST 3001, gRPC 50051 |
| Job Posting | `npm run dev` in `rolefit-job-posting-service` (`npm run seed` once for demo jobs) | gRPC 50052, HTTP health `HTTP_PORT` |
| Job Discovery | `npm run dev` in `rolefit-job-discovery-service` | REST 3002 |
| Application | per its own repo (owner: Pun) | REST 3004 |
| Resume Preparation | `npm run dev` in `rolefit-resume-preparation-service` | REST 3006, gRPC 50053 |
| Frontend | `npm run dev` in `rolefit-frontend` (`NEXT_PUBLIC_API_GATEWAY_URL=http://localhost:8080`) | 3000 |

Ports must not clash: Job Posting's health port (`HTTP_PORT`, default 3002) collides with Job Discovery's
3002, and Job Discovery's `PORT` must not be 3000 (the frontend). Locally use for example `HTTP_PORT=3003`
for Job Posting and `PORT=3002` for Job Discovery.

## Environment variables

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PORT` | no | `8080` | Gateway port |
| `FRONTEND_URL` | no | `http://localhost:3000` | The one origin allowed by CORS |
| `CANDIDATE_PROFILE_SERVICE_URL` | yes | – | e.g. `http://localhost:3001` |
| `JOB_DISCOVERY_SERVICE_URL` | yes | – | e.g. `http://localhost:3002` |
| `APPLICATION_SERVICE_URL` | yes | – | e.g. `http://localhost:3004` |
| `RESUME_PREPARATION_SERVICE_URL` | yes | – | e.g. `http://localhost:3006` |
| `JOB_POSTING_GRPC_URL` | yes | – | gRPC `host:port`, e.g. `localhost:50052` |
| `SUPABASE_URL` | yes | – | Supabase project URL (Auth project) |
| `SUPABASE_PUBLISHABLE_KEY` | yes | – | Supabase publishable key (never the service role key) |
| `NODE_ENV` | no | `development` | `test` silences logs |

## Errors

Every gateway error uses the services' shape: `{ "error": { "code": "...", "message": "..." } }`.

| Status | Code | When |
| --- | --- | --- |
| 400 | `MALFORMED_JSON` | invalid JSON body on a `/api/jobs` route |
| 401 | `MISSING_TOKEN` / `INVALID_TOKEN` / `TOKEN_EXPIRED` | no, bad or expired access token |
| 403 | `FORBIDDEN` | wrong role for the route (e.g. a seeker on `/api/jobs/mine/*` or changing an application status) |
| 403 | `NO_COMPANY` | a recruiter token has no `company_id` (sign in again after running the Supabase SQL) |
| 404 | `ROUTE_NOT_FOUND` | unknown gateway route |
| 413 | `PAYLOAD_TOO_LARGE` | body over the `/api/jobs` limit (1 MB JSON, 3 MB resume template) |
| 500 | `INTERNAL_ERROR` | unexpected gateway error (details are logged, not returned) |
| 503 | `SERVICE_UNAVAILABLE` | a service is down or timed out |

Service errors (for example `404 PROFILE_NOT_FOUND`) are passed through unchanged. Job Posting gRPC errors
are mapped: `INVALID_ARGUMENT` → 400 `VALIDATION_ERROR` (with `details`), `NOT_FOUND` → 404,
`FAILED_PRECONDITION` → 409 `INVALID_STATE`, `PERMISSION_DENIED` → 403, `UNAUTHENTICATED` → 401.

## Security note

The gateway is the security boundary only if the services' ports (3001, 3002, 3004, 3006, 50051/50052) are not
publicly reachable, because Job Discovery, the Application Service (and Candidate Profile with
`AUTH_MODE=mock`) trust the identity headers the gateway sets.
Outside local development, run Candidate Profile with `AUTH_MODE=jwt`.

## Example requests

```bash
TOKEN=<Supabase access token>   # e.g. from the browser: (await supabase.auth.getSession()).data.session.access_token

curl http://localhost:8080/health

curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/candidates/profiles/me

curl -H "Authorization: Bearer $TOKEN" "http://localhost:8080/api/discovery/jobs/search?query=react"

curl -H "Authorization: Bearer $TOKEN" "http://localhost:8080/api/jobs?query=react"
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start with reload (tsx watch) |
| `npm run build` / `npm start` | Compile to `dist/` / run the build |
| `npm test` | Tests (node:test) with fake services |
| `npm run typecheck` | TypeScript check |
