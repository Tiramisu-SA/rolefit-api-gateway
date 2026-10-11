# Real recruiter company id — Design

Date: 2026-10-11 · Status: approved · Builds on `2026-10-10-api-gateway-design.md`

## Goal

Stop using the mock `DEV_RECRUITER_COMPANY_ID` (`co-brightline`). Each recruiter's company id comes
from their verified Supabase token, so Job Posting ownership follows the real signed-in recruiter.

## Decisions

1. **One company per recruiter account.** Each recruiter signup creates a new company.
2. **Readable, unguessable id.** `co-<slug>-<6 hex>`, e.g. "Acme Corp" → `co-acme-corp-7f3a9c`. The random
   suffix means typing a company's name never grants access to its jobs. The frontend rebuilds a display
   name from the slug ("Acme Corp").
3. **Company names are unique** (case- and whitespace-insensitive) among recruiters. A second signup with
   a taken name is rejected: "This company is already registered."
4. **No backend service changes.** Job Posting keeps trusting `x-company-id`; only its value changes.

## Supabase (`rolefit-frontend/supabase/`, run by the user in the Supabase SQL editor)

### `auth-setup.sql` (updated, re-runnable)

- `public.normalize_company_name(text) → text` (immutable): `lower(trim(regexp_replace(name, '\s+', ' ', 'g')))`.
- `public.company_slug(text) → text` (immutable): lower-case, every run of non `[a-z0-9]` → `-`, trim `-`,
  cut to 40 chars, `'company'` if empty (e.g. a Thai name).
- `public.company_name_taken(name text) → boolean` (stable, `security definer`, `search_path = ''`): true if
  any user with `raw_app_meta_data->>'role' = 'recruiter'` has the same normalized `company_name`.
  `grant execute … to anon, authenticated` (the register page calls it before signing up).
- The existing `before insert` trigger function `set_role_on_signup` additionally, **for recruiters only**:
  - requires a non-empty `raw_user_meta_data->>'company'` (raise otherwise);
  - raises `'company already registered'` if `company_name_taken(company)`;
  - adds to `raw_app_meta_data`: `company_id = 'co-' || company_slug(company) || '-' || <6 hex>` where the
    hex is `substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)`, and `company_name = trim(company)`.
- `before insert` only: users can never change `role`, `company_id` or `company_name` afterwards.

### `backfill-company-ids.sql` (new, one-time, idempotent)

For every recruiter whose `raw_app_meta_data` has no `company_id`: set `company_id` (same formula, from
`raw_user_meta_data->>'company'`, `'company'` slug if missing) and `company_name` (typed name, or
`'Company'` if missing). Existing duplicates are not rejected — they just get different ids. Affected
users must sign in again (or wait for a token refresh) to get the new claims.

## Gateway

- `GatewayUser` gains `companyId?: string` and `companyName?: string`, read from `app_metadata.company_id`
  / `app_metadata.company_name` (strings only) by `authenticate`.
- New `requireCompany` middleware (after `requireRecruiter` on `/api/jobs/mine`): no `req.user.companyId` →
  403 `NO_COMPANY` "This recruiter account has no company yet. Sign out and sign in again."
- `/api/jobs/mine/*`: `x-company-id` and the `ListJobs.company_id` are `req.user.companyId`.
- `GET /api/jobs/mine/company` → `{ "companyId": "<id>", "companyName": "<name>" }` (`companyName` omitted if absent).
- `createJobRoutes(jobPosting)` — the `recruiterCompanyId` parameter is removed; so are
  `AppDependencies.recruiterCompanyId`, `GatewayConfig.recruiterCompanyId`, `DEV_RECRUITER_COMPANY_ID`
  (config, `.env.example`, README, tests).

## Frontend

- `src/lib/companies.ts`:
  - `companyFor(id)`: catalog ids unchanged; an id matching `^co-([a-z0-9]+(?:-[a-z0-9]+)*)-([0-9a-f]{6})$`
    → name = slug words title-cased ("acme-corp" → "Acme Corp"), initials from that name, fallback color;
    other unknown ids keep the current placeholder.
  - `initialsOf(name)`: first letters of the first two words, upper-case, `?` if none.
- `src/lib/auth/company.ts` (new): `isCompanyNameTaken(name): Promise<boolean>` → `supabase.rpc('company_name_taken', { name })`;
  an RPC error is thrown as `Error`.
- `role-context.tsx` `signUp`: for recruiters, if `isCompanyNameTaken(company)` → return
  "This company is already registered." before calling `supabase.auth.signUp` (the trigger is the backstop).
- `src/lib/api/job-posting.ts` `getRecruiterCompany()`: if the gateway returns `companyName`, use it as the
  name (and its initials) on top of `companyFor(companyId)`; otherwise `companyFor(companyId)`.
- `scripts/e2e-smoke.ts`: recruiter step asserts every own job has the recruiter's own company id and that
  the new draft appears in the own list (no seeded-Brightline assumption); `SMOKE_COMPANY_ID` removed
  (script header + README).
- `README.md`: one short section on running the two SQL files.

## Testing

- Gateway: `authenticate` copies company claims; `/mine` uses the token's company for metadata and
  `ListJobs`; recruiter without company → 403 `NO_COMPANY`; `/mine/company` returns id and name; env no
  longer knows `DEV_RECRUITER_COMPANY_ID`.
- Frontend: `companyFor` decodes readable ids (incl. `co-company-xxxxxx` → "Company"); `initialsOf`;
  `isCompanyNameTaken` calls the RPC; `getRecruiterCompany` prefers `companyName`.
- Live: user runs both SQL files, signs the test recruiter in again, then the smoke test passes.

## Out of scope

Shared companies / invites, company verification, renaming a company, company logos.
