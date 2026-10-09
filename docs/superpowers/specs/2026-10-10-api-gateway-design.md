# RoleFit API Gateway — Design

Date: 2026-10-10 · Status: approved

## Goal

Make the API Gateway the single public backend entry point for the RoleFit web frontend:

```
Frontend ──Authorization: Bearer <Supabase JWT>──▶ API Gateway ─┬─ HTTP ─▶ Candidate Profile Service (REST :3001)
                                                                ├─ HTTP ─▶ Job Discovery Service   (REST :3002)
                                                                └─ gRPC ─▶ Job Posting Service     (gRPC :50052)
```

The gateway handles routing/proxying, Supabase JWT verification, identity propagation,
CORS, request logging and error handling. It holds **no business logic**.

## Current state (inspected 2026-10-10)

| Service | Public API | Identity today |
|---|---|---|
| Candidate Profile | REST `/api/profiles/me/...` on `REST_PORT=3001` | `AUTH_MODE=jwt` verifies Supabase JWT via `getClaims()`; local `.env` uses `AUTH_MODE=mock` → trusts `X-User-Id` |
| Job Discovery | REST `/api/jobs/search`, `/api/recommendations`, `/api/jobs/:jobId/fit`, `/api/jobs/:jobId/match` on `PORT=3002` | mock: `X-User-Id` header (UUID) |
| Job Posting | **gRPC only** (`proto/job-posting.proto`, `rolefit.jobposting.v1.JobPostingService`) on `:50052`; HTTP port serves only `/health` | mock: gRPC metadata `x-user-id` + `x-company-id` (writes) |
| Frontend (Next.js 16) | browser `fetch` to Candidate Profile + Discovery (`NEXT_PUBLIC_*_API_URL`); Server Actions → gRPC for Job Posting | mock `NEXT_PUBLIC_DEV_SEEKER_USER_ID`, server-only `DEV_RECRUITER_USER_ID` / `DEV_RECRUITER_COMPANY_ID`; Supabase login already works (`session.accessToken`) |

All services: TypeScript, Express 5, `tsx`, `node:test`, error body `{ error: { code, message, details? } }`.

## Decisions

1. **Language/stack:** TypeScript + Express 5 + `tsx` + `node:test`, matching the services.
2. **Job Posting:** the gateway exposes REST `/api/jobs/*` and calls Job Posting over gRPC
   (protocol translation only). Job Posting Service is not modified.
3. **Identity:** the gateway verifies the JWT, then sets `X-User-Id = sub` (overwriting any
   client-sent value) and forwards `Authorization` unchanged. For Job Posting it sends
   `x-user-id = sub`, `x-company-id = DEV_RECRUITER_COMPANY_ID` (still a mock: the JWT has no company).
4. **No backend service is changed.**

## Gateway

### Layout

```
src/
  app.ts                      createApp(deps) — builds the Express app, no listen
  server.ts                   wires real deps, listens on PORT
  config/env.ts               loads + validates env (fail fast, all errors at once)
  auth/supabase.ts            createClaimsVerifier(url, key) using supabase.auth.getClaims()
  middleware/
    auth.middleware.ts        authenticate(verifier), requireRecruiter
    cors.middleware.ts        single-origin CORS + preflight
    logger.middleware.ts      one log line per request
    error.middleware.ts       notFoundHandler, errorHandler
  proxy/service-proxy.ts      createServiceProxy(target) — http-proxy-middleware wrapper
  routes/job.routes.ts        REST → gRPC route table for Job Posting
  grpc/job-posting.client.ts  createJobPostingCaller(url) → call(method, request, caller?)
  grpc/grpc-errors.ts         gRPC status → AppError (HTTP status + code + field details)
  utils/errors.ts             AppError + subclasses
  utils/logger.ts             same style as the services' logger
proto/job-posting.proto       copied from the Job Posting Service (as frontend/discovery do)
tests/                        node:test suites
```

`createApp` receives `{ verifyClaims, jobPosting, candidateProfileUrl, jobDiscoveryUrl, frontendUrl, recruiterCompanyId }`
so tests can inject a fake verifier, a fake gRPC caller and fake downstream HTTP servers.

### Middleware order

1. `logger` → 2. `cors` (answers `OPTIONS` with 204, never forwarded) → 3. `GET /health` →
4. `/api` → `authenticate` → 5. `/api/candidates` proxy, `/api/discovery` proxy, `/api/jobs` router →
6. `notFoundHandler` → 7. `errorHandler`.

No global body parser: proxied requests are streamed untouched. Only the `/api/jobs` router
parses bodies (`express.json({ limit: '1mb' })`; `express.raw` with a 3 MB limit for the resume-template upload).

### Routes

| Gateway route | Target |
|---|---|
| `GET /health` (no auth) | `{ "status": "ok", "service": "rolefit-api-gateway" }` |
| `ALL /api/candidates/*` | Candidate Profile `/api/*` — e.g. `GET /api/candidates/profiles/me` → `GET /api/profiles/me` |
| `ALL /api/discovery/*` | Job Discovery `/api/*` — e.g. `GET /api/discovery/jobs/search?query=react` → `GET /api/jobs/search?query=react` |
| `GET /api/jobs?query=` | gRPC `ListJobs { status: JOB_STATUS_OPEN, query, limit: 100 }`, no metadata |
| `GET /api/jobs/:jobId` | gRPC `GetJob { job_id }`, no metadata (drafts never returned) |
| `GET /api/jobs/mine?status=&query=` | `ListJobs { company_id, status, query, limit: 100 }` + recruiter metadata |
| `GET /api/jobs/mine/company` | `{ "companyId": "<DEV_RECRUITER_COMPANY_ID>" }` (no gRPC call) |
| `POST /api/jobs/mine` | `CreateJob { job: <body> }` |
| `GET /api/jobs/mine/:jobId` | `GetJob { job_id }` (own drafts visible) |
| `PUT /api/jobs/mine/:jobId` | `UpdateJob { job_id, job: <body> }` |
| `DELETE /api/jobs/mine/:jobId` | `DeleteJob { job_id }` → 204 |
| `POST /api/jobs/mine/:jobId/publish` · `/close` · `/reopen` | `PublishJob` · `CloseJob` · `ReopenJob { job_id }` |
| `GET /api/jobs/mine/:jobId/resume-template` | `GetResumeTemplate { job_id, include_content: false }` |
| `PUT /api/jobs/mine/:jobId/resume-template` | raw body + `Content-Type` + `X-File-Name` → `AttachResumeTemplate { job_id, file_name, content_type, content }` |
| `DELETE /api/jobs/mine/:jobId/resume-template` | `DeleteResumeTemplate { job_id }` → 204 |

`/api/jobs/mine/*` requires `app_metadata.role === "recruiter"` (403 `FORBIDDEN` otherwise).
Every Job Posting route returns the gRPC response message as JSON **unchanged** (proto-loader options
`keepCase, longs: String, enums: String, defaults: true, oneofs: true` — identical to the frontend's
current client), with status 200 (204 for deletes). The frontend keeps mapping proto ↔ UI types.
Request bodies are proto-shaped (the frontend's existing `toProtoJobInput`), and the `status` query
parameter is the proto enum name (`JOB_STATUS_DRAFT` / `JOB_STATUS_OPEN` / `JOB_STATUS_CLOSED`; absent = any),
as produced by the existing `toProtoStatus`. `/api/jobs/mine…` routes are registered before `/api/jobs/:jobId`
so `mine` is never treated as a job id.

### Authentication (`authenticate`)

1. Read `Authorization`; no `Bearer <token>` → 401 `MISSING_TOKEN`.
2. `verifyClaims(token)` (Supabase `getClaims()`); `null`/throws/no string `sub` → 401.
   Code is `TOKEN_EXPIRED` if the token's (unverified) `exp` is in the past, else `INVALID_TOKEN`.
   The unverified payload is used **only** to choose the error message.
3. Set `req.user = { id: sub, role: app_metadata.role }`.
4. Delete client-sent `x-user-id` / `x-company-id`; set `x-user-id: <sub>`. Keep `Authorization`.

Candidate Profile therefore works in both its `mock` and `jwt` modes; Discovery's mock middleware gets a real user id.

### Proxy (`createServiceProxy`)

`http-proxy-middleware` v3: `target`, `changeOrigin: true`, path rewrite `^/` → `/api/` on the
mount-stripped path, `proxyTimeout: 10000`. On response, delete `access-control-*` headers (the
gateway owns CORS, duplicates would break the browser). On error (ECONNREFUSED, timeout) → 503
`SERVICE_UNAVAILABLE` JSON. Downstream statuses and bodies are passed through as-is (a 404 stays 404).

### gRPC error mapping (moved from the frontend's `grpcErrorToApiError`)

| gRPC status | HTTP | code |
|---|---|---|
| INVALID_ARGUMENT | 400 | `VALIDATION_ERROR` (+ `details` from the `x-validation-errors` trailer) |
| NOT_FOUND | 404 | `NOT_FOUND` |
| FAILED_PRECONDITION | 409 | `INVALID_STATE` |
| PERMISSION_DENIED | 403 | `FORBIDDEN` |
| UNAUTHENTICATED | 401 | `UNAUTHENTICATED` |
| UNAVAILABLE, DEADLINE_EXCEEDED | 503 | `SERVICE_UNAVAILABLE` |
| other | 500 | `INTERNAL_ERROR` |

The message is the gRPC `details` text for 4xx codes and a generic text for 5xx codes. gRPC deadline: 5000 ms.

### Gateway-level errors

All as `{ error: { code, message, details? } }`: `MISSING_TOKEN` 401, `INVALID_TOKEN` 401,
`TOKEN_EXPIRED` 401, `FORBIDDEN` 403, `SERVICE_UNAVAILABLE` 503, `ROUTE_NOT_FOUND` 404,
`MALFORMED_JSON` 400, `PAYLOAD_TOO_LARGE` 413, `INTERNAL_ERROR` 500 (logged, details hidden).

### CORS

Origin = `FRONTEND_URL` (never `*`), `Vary: Origin`. Preflight: methods
`GET, POST, PUT, PATCH, DELETE, OPTIONS`, headers `Authorization, Content-Type, X-File-Name`, max-age 600.

### Environment (`.env.example`)

```
NODE_ENV=development
PORT=8080
FRONTEND_URL=http://localhost:3000
CANDIDATE_PROFILE_SERVICE_URL=http://localhost:3001
JOB_DISCOVERY_SERVICE_URL=http://localhost:3002
JOB_POSTING_GRPC_URL=localhost:50052
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_<key>
DEV_RECRUITER_COMPANY_ID=co-brightline
```

`JOB_POSTING_GRPC_URL` (host:port, gRPC) replaces the suggested `JOB_POSTING_SERVICE_URL` because the
service has no HTTP API. `SUPABASE_PUBLISHABLE_KEY` follows the services' existing naming (it replaces the legacy anon key).
Required: both Supabase vars and the three service URLs; the rest have defaults.

## Frontend migration (`rolefit-frontend`, networking only)

- **New** `src/lib/api/gateway.ts`: `gatewayRequest<T>(method, path, { json?, body?, headers?, query? })` —
  base URL from `NEXT_PUBLIC_API_GATEWAY_URL` (literal read so Next inlines it), token from
  `supabase.auth.getSession()` → `Authorization: Bearer`, 204 → `undefined`, fetch failure → `ApiError("SERVICE_UNAVAILABLE", …, 503)`,
  non-2xx → `ApiError(error.code, error.message, status, error.details)`.
- `candidate-profile.ts`: use `gatewayRequest` with prefix `/api/candidates/profiles`; drop `X-User-Id` and the per-service URL.
- `job-discovery.ts`: use `gatewayRequest` with prefix `/api/discovery`; drop `X-User-Id` and the per-service URL.
- `job-posting.ts`: same exported functions and signatures, now `gatewayRequest` to `/api/jobs…` and mapping
  with `toJobPosting` / `toProtoJobInput` / `toProtoStatus` / `toResumeTemplateInfo`. `getResumeTemplate` returns null on 404 `NOT_FOUND`.
  `getRecruiterCompany` → `companyFor((await GET /api/jobs/mine/company).companyId)`.
- Move `src/lib/grpc/job-mapper.ts` (+ test) to `src/lib/api/job-mapper.ts`; remove `GRPC_STATUS` / `grpcErrorToApiError` (now in the gateway).
- **Delete:** `src/lib/api/job-posting-actions.ts`, `src/lib/grpc/job-posting-client.ts`, `src/lib/identity.ts`,
  `src/lib/identity.server.ts`, `proto/`; remove `@grpc/grpc-js`, `@grpc/proto-loader`, `server-only` (if then unused)
  from `package.json`; remove the gRPC/Server Action settings from `next.config.ts`.
- `.env.example`: add `NEXT_PUBLIC_API_GATEWAY_URL=http://localhost:8080`; remove service URLs and `DEV_*` mock ids.
- `scripts/e2e-smoke.ts`: sign in with seeker/recruiter credentials from env (`SMOKE_SEEKER_EMAIL`/`_PASSWORD`,
  `SMOKE_RECRUITER_EMAIL`/`_PASSWORD`) and run through the gateway.
- No changes to pages, components, styling or behaviour. All API callers are already client components.

## Testing

Gateway (`node:test` via `tsx`, fake verifier, fake gRPC caller, fake downstream Express servers on port 0):

1. `GET /health` → 200 without a token
2. protected route without token → 401 `MISSING_TOKEN`
3. invalid token → 401 `INVALID_TOKEN`; expired → 401 `TOKEN_EXPIRED`
4. requests reach the correct service with the rewritten path, `X-User-Id = sub`, `Authorization` kept, spoofed `X-User-Id` replaced
5. query strings preserved
6. JSON bodies preserved (and raw bodies for resume import)
7. downstream statuses preserved (404 stays 404); gRPC errors mapped per table
8. downstream down → 503 `SERVICE_UNAVAILABLE`
9. unknown route → 404 `ROUTE_NOT_FOUND`; CORS preflight → 204 with the configured origin; seeker on `/api/jobs/mine` → 403

Frontend: `npm run lint`, `npm test`, `npm run build`, and a grep showing no `localhost:300x`, `*_API_URL`
(other than the gateway) or `GRPC` references in `src/`.

## Out of scope

Changing any backend service; real company/tenant model; rate limiting, caching, service discovery,
load balancing, Docker/Kubernetes for the gateway.

## Known consequences

- Seeker data is now keyed by the real Supabase user id, not the shared mock UUID (existing mock-id profiles are not visible).
- The recruiter company is still the dev mock `DEV_RECRUITER_COMPANY_ID`, now held by the gateway.
- Job Posting `HTTP_PORT=3002` in its local `.env` clashes with Discovery's `3002`; it only affects Job Posting's `/health` and is not changed here.
