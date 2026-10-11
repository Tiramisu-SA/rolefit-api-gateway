# RoleFit API Gateway

The single public backend entry point for the RoleFit web frontend. It verifies the user's
Supabase access token, then routes the request to the right microservice. It holds no business logic.

## Architecture

```
Frontend ──Authorization: Bearer <Supabase JWT>──▶ API Gateway (:8080)
                                                     ├─ HTTP ─▶ Candidate Profile Service (:3001)
                                                     ├─ HTTP ─▶ Job Discovery Service     (:3002)
                                                     ├─ HTTP ─▶ Application Service       (:3004, in development)
                                                     └─ gRPC ─▶ Job Posting Service       (:50052)
```

For every `/api/*` request the gateway:

1. verifies the Supabase JWT (`supabase.auth.getClaims()`), returning `401` if it is missing, invalid or expired;
2. sets `X-User-Id`, `X-User-Role` and (for recruiters) `X-Company-Id` from the token, replacing any client-sent values, and keeps `Authorization`;
   For recruiters, the company comes from the token too: `app_metadata.company_id` (set by the Supabase signup trigger) is sent to Job Posting as `x-company-id`; a recruiter token without it gets `403 NO_COMPANY`.
3. forwards the request and returns the service's status and body unchanged.

## Services and routes

| Gateway route | Service | Upstream |
| --- | --- | --- |
| `GET /health` | gateway (no auth) | – |
| `/api/candidates/*` | Candidate Profile Service | `/api/*`, e.g. `/api/candidates/profiles/me` → `/api/profiles/me` |
| `/api/discovery/*` | Job Discovery Service | `/api/*`, e.g. `/api/discovery/recommendations` → `/api/recommendations` |
| `GET /api/applications/mine` (seekers) | Application Service | same path |
| `GET /api/applications?jobId=` (recruiters) | Application Service | same path |
| `GET /api/applications/:applicationId` (seeker or recruiter) | Application Service | same path |
| `PATCH /api/applications/:applicationId/status` (recruiters) | Application Service | same path |
| `GET /api/jobs`, `GET /api/jobs/:jobId` | Job Posting Service | gRPC `ListJobs` (open jobs) / `GetJob` |
| `/api/jobs/mine/*` (recruiters only) | Job Posting Service | gRPC `ListJobs`, `CreateJob`, `GetJob`, `UpdateJob`, `DeleteJob`, `PublishJob`, `CloseJob`, `ReopenJob`, `Get/Attach/DeleteResumeTemplate` |

Other paths under `/api/applications` (for example submitting an application) are a gateway `404`.

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

Requires Node 20+ and the three services running locally.

```bash
npm install
cp .env.example .env   # then fill in SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY
npm run dev            # or: npm run build && npm start
```

The gateway listens on `http://localhost:8080`. Start the services first:

| Service | Start | Port |
| --- | --- | --- |
| Candidate Profile | `npm run dev` in `rolefit-candidate-profile-service` | REST 3001, gRPC 50051 |
| Job Posting | `npm run dev` in `rolefit-job-posting-service` | gRPC 50052 |
| Job Discovery | `npm run dev` in `rolefit-job-discovery-service` | REST 3002 |
| Application | per its own repo (owner: Pun) | REST 3004 (in development) |
| Frontend | `npm run dev` in `rolefit-frontend` (`NEXT_PUBLIC_API_GATEWAY_URL=http://localhost:8080`) | 3000 |

Job Posting's local `.env` sets `HTTP_PORT=3002`, which clashes with Job Discovery. That port only serves
Job Posting's own `/health`, so start Job Discovery first or change Job Posting's `HTTP_PORT` locally (for example to 3003).

## Environment variables

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `PORT` | no | `8080` | Gateway port |
| `FRONTEND_URL` | no | `http://localhost:3000` | The one origin allowed by CORS |
| `CANDIDATE_PROFILE_SERVICE_URL` | yes | – | e.g. `http://localhost:3001` |
| `JOB_DISCOVERY_SERVICE_URL` | yes | – | e.g. `http://localhost:3002` |
| `APPLICATION_SERVICE_URL` | yes | – | e.g. `http://localhost:3004` |
| `JOB_POSTING_GRPC_URL` | yes | – | gRPC `host:port`, e.g. `localhost:50052` |
| `SUPABASE_URL` | yes | – | Supabase project URL (Auth project) |
| `SUPABASE_PUBLISHABLE_KEY` | yes | – | Supabase publishable key (never the service role key) |
| `NODE_ENV` | no | `development` | `test` silences logs |

## Errors

Every gateway error uses the services' shape: `{ "error": { "code": "...", "message": "..." } }`.

| Status | Code | When |
| --- | --- | --- |
| 401 | `MISSING_TOKEN` / `INVALID_TOKEN` / `TOKEN_EXPIRED` | no, bad or expired access token |
| 403 | `FORBIDDEN` | a non-recruiter calls `/api/jobs/mine/*` |
| 403 | `NO_COMPANY` | a recruiter token has no `company_id` (sign in again after running the Supabase SQL) |
| 404 | `ROUTE_NOT_FOUND` | unknown gateway route |
| 503 | `SERVICE_UNAVAILABLE` | a service is down or timed out |

Service errors (for example `404 PROFILE_NOT_FOUND`) are passed through unchanged. Job Posting gRPC errors
are mapped: `INVALID_ARGUMENT` → 400 `VALIDATION_ERROR` (with `details`), `NOT_FOUND` → 404,
`FAILED_PRECONDITION` → 409 `INVALID_STATE`, `PERMISSION_DENIED` → 403, `UNAUTHENTICATED` → 401.

## Security note

The gateway is the security boundary only if the services' ports (3001, 3002, 50051/50052) are not publicly
reachable, because Job Discovery (and Candidate Profile with `AUTH_MODE=mock`) trust the `X-User-Id` header.
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
