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
                                                     ├─ HTTP ─▶ Company Service           (:3008)
                                                     └─ gRPC ─▶ Job Posting Service       (:50052)
```

For every `/api/*` request the gateway:

1. verifies the Supabase JWT (`supabase.auth.getClaims()`), returning `401` if it is missing, invalid or expired;
2. sets `X-User-Id` (token `sub`), `X-User-Role` (`app_metadata.role`) and, for recruiters, `X-Company-Id`
   (`app_metadata.company_id`, set by the Supabase signup trigger) and `X-Company-Name` (`app_metadata.company_name`,
   URI-encoded), replacing any client-sent values, and keeps
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
| `GET`, `PUT /api/companies/me` (recruiters with a company) | Company Service | same path |
| `GET /api/companies/:companyId` (any signed-in user) | Company Service | same path |
| `GET`, `PUT /api/recruiters/me` (recruiters with a company) | Company Service | same path |
| `GET /api/jobs`, `GET /api/jobs/:jobId` | Job Posting Service | gRPC `ListJobs` (open jobs) / `GetJob` |
| `/api/jobs/mine/*` (recruiters only) | Job Posting Service | gRPC `ListJobs`, `CreateJob`, `GetJob`, `UpdateJob`, `DeleteJob`, `PublishJob`, `CloseJob`, `ReopenJob`, `Get/Attach/DeleteResumeTemplate` |

Other paths under `/api/applications`, `/api/companies` and `/api/recruiters` are a gateway `404`.

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

## Run the whole backend with Docker Compose

[`deploy/docker-compose.yml`](deploy/docker-compose.yml) starts the gateway, all seven services and their
infrastructure (PostgreSQL, MongoDB, RabbitMQ, Mailpit) with one command. It needs Docker and the service repos
cloned next to this one:

```
RoleFit/
├── rolefit-api-gateway/          ← this repo (deploy/docker-compose.yml)
├── rolefit-candidate-profile-service/
├── rolefit-job-posting-service/   (dev branch)
├── rolefit-job-discovery-service/
├── rolefit-resume-preparation-service/
├── rolefit-application-service/
└── rolefit-notification-service/
```

```bash
cd deploy
cp .env.example .env        # fill in the Supabase URL/key and the two cloud database URLs
docker compose up -d --build
docker compose ps           # every service should become "healthy"
```

Then run the frontend as usual (`npm run dev` in `rolefit-frontend`, gateway URL `http://localhost:8080`).
Stop everything with `docker compose down` (add `-v` to also delete the local databases).

**Service discovery.** All containers join one Docker network, and Docker's built-in DNS resolves a service name to
the container's current address. Services therefore call each other by name, not by a fixed host and port, for
example `http://candidate-profile:3001` or `job-posting:50052`. Moving, restarting or scaling a service
(`docker compose up -d --scale job-discovery=2`) needs no configuration change in its callers. Compose also starts
the services in dependency order and waits for each one's health check before starting the services that call it.

| Service name (DNS) | Port(s) inside the network | Reachable from the host |
| --- | --- | --- |
| `api-gateway` | 8080 | `http://localhost:8080` |
| `candidate-profile` | REST 3001, gRPC 50051 | no |
| `job-posting` | gRPC 50052 | no |
| `job-discovery` | REST 3002 | no |
| `resume-preparation` | REST 3006, gRPC 50053 | no |
| `application` | REST 3004 | no |
| `notification` | health 3005 | no |
| `company` | REST 3008 | no |
| `postgres`, `mongo`, `rabbitmq`, `mailpit` | 5432, 27017, 5672, 1025 | RabbitMQ UI `:15672`, Mailpit inbox `:8025` |

Only the gateway is published, so the services' identity headers can't be forged from outside (see
[Security note](#security-note)). Supabase (Auth and the Candidate Profile database) and MongoDB Atlas (Job Posting)
stay in the cloud; their URLs and keys come from `deploy/.env`, which is gitignored.

Resume Preparation uses the rule-based AI adapter by default. To use Gemini, add `AI_PROVIDER=gemini`, `AI_API_KEY`
and `AI_MODEL` (the model id from AI Studio) to `deploy/.env`; it falls back to rule-based if Gemini fails.

### Upgrading an existing stack

The company database init (`deploy/postgres-init/002-company.sql`) only runs on a fresh Postgres volume. With an
existing volume, run it once:

```bash
docker compose exec postgres psql -U postgres -f /docker-entrypoint-initdb.d/002-company.sql
```

Or reset local data entirely with `docker compose down -v`.

If a build stops with `failed to receive status ... EOF`, Docker ran out of memory or disk space: free some space
and build the images one at a time (`docker compose build api-gateway`, then the next).

## Local setup (without Docker)

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
| Company | `npm run dev` in `rolefit-company-service` (needs `DATABASE_URL`) | REST 3008 |
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
| `COMPANY_SERVICE_URL` | yes | – | e.g. `http://localhost:3008` |
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

## Request id and tracing

Every response has an `X-Request-Id` header. The gateway keeps the client's `X-Request-Id` if it is safe
(1–128 letters, digits, `.`, `_`, `-`), otherwise it creates a UUID. Every service logs that id and passes it on:

| Hop | How the id travels |
| --- | --- |
| HTTP | `X-Request-Id` header |
| gRPC | `x-request-id` metadata |
| RabbitMQ (Application → Notification) | AMQP correlation id. It is stored with the outbox event and the delivery job, so it survives both background workers. The event payload is unchanged. |

Each service writes JSON logs, one object per line: `time`, `level`, `service`, `requestId`, `message` and any other
fields. A request or RPC logs one line when it ends, with its status and `durationMs`. Logs leave out query strings,
tokens and email addresses, and `/health` and `/ready` are not logged.

To follow one request, copy `X-Request-Id` from the browser's Network tab, then search all the logs from `deploy/`:

```bash
docker compose logs --no-log-prefix | grep <id>            # Git Bash, macOS, Linux
docker compose logs --no-log-prefix | Select-String <id>   # PowerShell
```

Docker groups the output by container, so use the `time` field to read it in order. For example, with Job Posting
stopped, the `503` from recommendations shows which service failed (fields shortened here):

```json
{"service":"candidate-profile","requestId":"req-1","message":"rpc completed","rpc":"GetProfile","grpcStatus":"OK"}
{"service":"job-discovery","requestId":"req-1","level":"error","message":"job service is unavailable","upstream":"job"}
{"service":"job-discovery","requestId":"req-1","message":"request completed","path":"/api/recommendations","status":503}
{"service":"api-gateway","requestId":"req-1","message":"request completed","path":"/api/discovery/recommendations","status":503}
```

## Measuring performance (NFR)

[`scripts/measure-performance.mjs`](scripts/measure-performance.mjs) times the main routes through the gateway
against the performance targets: normal requests within 2 s, AI requests within 10–20 s. It needs only Node 22+.

```bash
cd deploy && docker compose up -d --build && cd ..
cp scripts/perf.env.example scripts/perf.env   # a test job seeker account with a profile
node scripts/measure-performance.mjs           # --runs 20 --ai-runs 5 --concurrency 1 --only normal|ai
```

It signs in as the test seeker, makes one untimed warm-up call per route, then times `--runs` calls (AI routes:
`--ai-runs`, one at a time, because each call uses the AI provider's quota) until the whole response has arrived.
A route passes when every call succeeds and p95 is within its target. Results are printed and saved to
`scripts/perf-results/` as JSON and as a Markdown table for the report. Each call sends
`X-Request-Id: perf-<route>-<n>`, so a slow call can be found in the service logs. Generating a draft replaces
the test seeker's draft for that job. For the AI numbers, set `AI_PROVIDER=gemini` in `deploy/.env` and check the
Resume Preparation log for "AI tailoring failed", which means the rule-based fallback answered instead.

### Load and stress tests

[`scripts/load-test.mjs`](scripts/load-test.mjs) runs many virtual users at once. Each one repeats a seeker journey
of 8 normal requests (job list, search, recommendations, job detail, job fit, resume draft, my applications,
profile) with about 1 s of think time between them. AI routes are left out, because every call uses provider quota.

```bash
node scripts/load-test.mjs load     # 50 users for 60 s (after a 10 s ramp-up): --users --duration --ramp --think
node scripts/load-test.mjs stress   # 10 → 25 → 50 → 100 → 150 → 200 users, 30 s each: --stages --stage-duration
```

- **Load test:** checks the expected load (the NFR's "tens of concurrently active users"). It passes when p95 ≤ 2 s
  and fewer than 1% of requests fail.
- **Stress test:** adds users stage by stage. It reports the largest stage still within the target, the stage where
  the system breaks and its slowest action, and where throughput (successful requests per second) stops growing. It
  stops early if more than half of the requests fail.

Both print a table and save JSON and Markdown to `scripts/perf-results/`, with the likely meaning of each error code
(for example, Supabase limiting token checks). The load generator runs on the same machine as the services, so the
results show the limit of that machine, not of a production deployment.

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
