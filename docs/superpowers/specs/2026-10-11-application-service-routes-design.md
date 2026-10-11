# Application Service routes in the gateway — Design

Date: 2026-10-11 · Status: approved · Source: Notion "Application Service API" (owner: Pun)

## Goal

Route the Application Service's four business endpoints through the API Gateway now, as a template,
while the service itself is still being finished. The frontend keeps its browser mock until the service
supports submitting applications.

## Upstream contract (from the Notion doc)

- Local address `http://localhost:3004`; routes live under `/api/applications` upstream too.
- Trusts three headers from the gateway: `X-User-Id` (JWT `sub`), `X-User-Role` (`seeker` | `recruiter`),
  `X-Company-Id` (every recruiter call; verified `app_metadata.company_id`). It does not verify JWTs.
- Errors: `{ "error": { "code", "message" } }` (`VALIDATION_ERROR` 400, `MISSING_IDENTITY` 401, `FORBIDDEN` 403,
  `APPLICATION_NOT_FOUND` 404, `ROUTE_NOT_FOUND` 404, `NOTIFICATION_DATA_INVALID` 409, `SERVICE_UNAVAILABLE` 503).

## Gateway routes

| Gateway route | Gateway check | Upstream |
|---|---|---|
| `GET /api/applications/mine` | seeker | `GET /api/applications/mine` |
| `GET /api/applications?jobId=…` | recruiter with company | `GET /api/applications?jobId=…` |
| `GET /api/applications/:applicationId` | seeker, or recruiter with company | same path |
| `PATCH /api/applications/:applicationId/status` | recruiter with company | same path, JSON body streamed |
| any other method/path under `/api/applications` | — | gateway 404 `ROUTE_NOT_FOUND` (never forwarded) |

Wrong role → 403 `FORBIDDEN`; recruiter token without company → 403 `NO_COMPANY`; service down → 503
`SERVICE_UNAVAILABLE` ("The application service is unavailable. Please try again."). Service statuses and
bodies pass through unchanged. The service repeats all role/ownership checks.

## Identity headers (all proxied requests)

`authenticate` removes client-sent `x-user-id`, `x-user-role`, `x-company-id`, then sets `x-user-id = sub`,
`x-user-role = app_metadata.role` (when present) and `x-company-id = app_metadata.company_id` (when present).
Never a fallback company. Candidate Profile and Job Discovery ignore the extra headers.

## Proxy path

`createServiceProxy(target, service, upstreamPrefix = '/api')`: upstream path = `upstreamPrefix` + the
mount-relative path, except a bare `/` (with or without query) maps to `upstreamPrefix` itself
(`/?jobId=x` → `/api/applications?jobId=x`). Existing mounts keep `/api` (`/profiles/me` → `/api/profiles/me`).

## Config and docs

Required `APPLICATION_SERVICE_URL` (`http://localhost:3004`) in config, `.env.example`, README (env table,
routes, architecture), local `.env`.

## Testing

Forged identity headers replaced; recruiter company injected from the token; seeker write / wrong-role
reads refused; recruiter without company refused; path, query and JSON body preserved; service error
statuses preserved; unsupported route 404 without forwarding; service down 503; missing token 401;
config requires the new variable.

## Out of scope

Frontend integration, application submission, Notification Service, RabbitMQ.
