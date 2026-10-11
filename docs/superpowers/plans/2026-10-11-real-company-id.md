# Real Recruiter Company Id Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mock `DEV_RECRUITER_COMPANY_ID` with a per-recruiter company id issued by Supabase at signup and read by the gateway from the verified token.

**Architecture:** A Supabase signup trigger writes `company_id` (`co-<slug>-<6hex>`) and `company_name` into the trusted `app_metadata`; company names are unique. The gateway copies these claims into `req.user` and uses them for Job Posting calls. The frontend decodes readable ids into display names and checks name availability before signup.

**Tech Stack:** Supabase Postgres (plpgsql), TypeScript, Express 5, node:test (gateway); Next.js 16, vitest, @supabase/supabase-js (frontend).

**Spec:** `docs/superpowers/specs/2026-10-11-real-company-id-design.md`

## Global Constraints

- Do NOT modify `rolefit-candidate-profile-service`, `rolefit-job-discovery-service` or `rolefit-job-posting-service`.
- Company id format: `co-<slug>-<6 lowercase hex>`; slug = lower-case, non `[a-z0-9]` runs → `-`, trimmed of `-`, max 40 chars, `company` if empty.
- Company names unique among recruiters, compared with `lower(trim(regexp_replace(name, '\s+', ' ', 'g')))`.
- Claims: `app_metadata.company_id`, `app_metadata.company_name` (strings).
- Recruiter without `company_id` on `/api/jobs/mine/*` → 403 `NO_COMPANY`, message `This recruiter account has no company yet. Sign out and sign in again.`
- Signup message when the name is taken: `This company is already registered.`
- Error body shape: `{ "error": { "code": string, "message": string, "details"?: FieldError[] } }`.
- Frontend: no page/component/styling changes; only `role-context.tsx` signUp logic, lib code, scripts, SQL and docs.
- Never commit `.env` files or secrets. Quote globs in zsh.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Branches: gateway `feat/real-company-id` (from `main`); frontend `feat/real-company-id` (from `feat/api-gateway`). Both already checked out.

---

### Task 1: Gateway — company from the token

Repo: `/Users/nif/dev/SoftwareArchitecture/RoleFit/rolefit-api-gateway`

**Files:**
- Modify: `src/utils/errors.ts`, `src/middleware/auth.middleware.ts`, `src/routes/job.routes.ts`, `src/app.ts`, `src/server.ts`, `src/config/env.ts`, `.env.example`, `README.md`
- Modify tests: `tests/helpers.ts`, `tests/auth.test.ts`, `tests/job.routes.test.ts`, `tests/app.test.ts`, `tests/env.test.ts`

**Interfaces:**
- Produces: `noCompany()` error factory; `GatewayUser { id; role?; companyId?; companyName? }`; `requireCompany` middleware; `createJobRoutes(jobPosting: JobPostingCaller): Router` (one parameter); `AppDependencies` and `GatewayConfig` without `recruiterCompanyId`; `GET /api/jobs/mine/company` → `{ companyId, companyName? }`.

- [ ] **Step 1: Update test fakes in `tests/helpers.ts`**

Replace the `fakeVerifier` block with:

```ts
export const COMPANY_ID = 'co-acme-corp-7f3a9c';

/** Accepts "seeker-token", "recruiter-token" and "recruiter-no-company-token"; everything else is invalid. */
export const fakeVerifier: ClaimsVerifier = async (token) => {
  if (token === 'seeker-token') return { sub: SEEKER, app_metadata: { role: 'seeker' } };
  if (token === 'recruiter-token') {
    return { sub: RECRUITER, app_metadata: { role: 'recruiter', company_id: COMPANY_ID, company_name: 'Acme Corp' } };
  }
  if (token === 'recruiter-no-company-token') return { sub: RECRUITER, app_metadata: { role: 'recruiter' } };
  return null;
};
```

- [ ] **Step 2: Write failing tests**

In `tests/auth.test.ts`:
- Add `COMPANY_ID` to the import from `./helpers`.
- Append:

```ts
test('company claims from app_metadata are copied into req.user', async () => {
  const { status, body } = await call('/echo', { Authorization: 'Bearer recruiter-token' });
  assert.equal(status, 200);
  assert.deepEqual(body.user, { id: RECRUITER_ID, role: 'recruiter', companyId: COMPANY_ID, companyName: 'Acme Corp' });
});

test('requireCompany refuses a recruiter token without company_id with 403 NO_COMPANY', async () => {
  const { status, body } = await call('/recruiter-company', { Authorization: 'Bearer recruiter-no-company-token' });
  assert.equal(status, 403);
  assert.deepEqual(body.error, { code: 'NO_COMPANY', message: 'This recruiter account has no company yet. Sign out and sign in again.' });
  const ok = await call('/recruiter-company', { Authorization: 'Bearer recruiter-token' });
  assert.equal(ok.status, 200);
});
```
- Import `RECRUITER` as `RECRUITER_ID` (`import { …, RECRUITER as RECRUITER_ID } from './helpers'`), import `requireCompany` from `../src/middleware/auth.middleware`, and in `app()` add before `a.use(errorHandler)`:

```ts
  a.get('/recruiter-company', requireRecruiter, requireCompany, (_req, res) => {
    res.json({ ok: true });
  });
```
- The existing seeker test's expected `user` stays `{ id: SEEKER, role: 'seeker' }` (no company keys — they must be absent, not `undefined`, in JSON).

In `tests/job.routes.test.ts`:
- Change `withJobs` so the stand-in for `authenticate` sets company claims for recruiters, and accepts a `'recruiter-no-company'` role:

```ts
type Who = 'seeker' | 'recruiter' | 'recruiter-no-company';

async function withJobs(who: Who, jobPosting: JobPostingCaller, fn: (base: string) => Promise<void>) {
  const app = express();
  app.use((req, _res, next) => {
    req.user =
      who === 'seeker'
        ? { id: SEEKER, role: 'seeker' }
        : who === 'recruiter'
          ? { id: RECRUITER, role: 'recruiter', companyId: COMPANY_ID, companyName: 'Acme Corp' }
          : { id: RECRUITER, role: 'recruiter' };
    next();
  });
  app.use('/api/jobs', createJobRoutes(jobPosting));
  app.use(errorHandler);
  const { base, close } = await listen(app);
  try {
    await fn(base);
  } finally {
    await close();
  }
}

const recruiterCaller = { userId: RECRUITER, companyId: COMPANY_ID };
```
- Import `COMPANY_ID` from `./helpers`. Replace every `'co-test'` in this file with `COMPANY_ID`.
- Change the `/mine/company` test expectation to `{ companyId: COMPANY_ID, companyName: 'Acme Corp' }`.
- Append:

```ts
test('a recruiter without a company gets 403 NO_COMPANY and no RPC is made', async () => {
  const { call, calls } = recording();
  await withJobs('recruiter-no-company', call, async (base) => {
    const res = await fetch(`${base}/api/jobs/mine`);
    assert.equal(res.status, 403);
    assert.equal((await errorOf(res)).code, 'NO_COMPANY');
  });
  assert.equal(calls.length, 0);
});
```

In `tests/app.test.ts`: delete the line `recruiterCompanyId: 'co-test',` from the `createApp({...})` call.

In `tests/env.test.ts`:
- First test: `const config = loadConfig(valid);` and delete the `recruiterCompanyId` assertion.
- Second test: delete the `recruiterCompanyId` assertion.
- Append:

```ts
test('loadConfig no longer reads DEV_RECRUITER_COMPANY_ID', () => {
  const config = loadConfig({ ...valid, DEV_RECRUITER_COMPANY_ID: 'co-x' }) as unknown as Record<string, unknown>;
  assert.equal('recruiterCompanyId' in config, false);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `requireCompany` is not exported / company claims missing / `/mine/company` shape mismatch.

- [ ] **Step 4: Implement**

`src/utils/errors.ts` — append:

```ts
export const noCompany = () =>
  new AppError('This recruiter account has no company yet. Sign out and sign in again.', 403, 'NO_COMPANY');
```

`src/middleware/auth.middleware.ts`:
- Import `noCompany` alongside the other error factories.
- Extend the interface:

```ts
export interface GatewayUser {
  /** Supabase user id (JWT `sub`). */
  id: string;
  /** `app_metadata.role`: "seeker" or "recruiter". Only the Supabase server can write it. */
  role?: string;
  /** `app_metadata.company_id`, set once at recruiter signup, e.g. "co-acme-corp-7f3a9c". */
  companyId?: string;
  /** `app_metadata.company_name`, the company name typed at signup. */
  companyName?: string;
}
```
- Replace the two lines that build `req.user` with:

```ts
    const meta = claims.app_metadata ?? {};
    const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
    req.user = { id: claims.sub, role: text(meta.role) };
    const companyId = text(meta.company_id);
    const companyName = text(meta.company_name);
    if (companyId) req.user.companyId = companyId;
    if (companyName) req.user.companyName = companyName;
```
(Keep `role` exactly as before: `role: text(meta.role)` gives `undefined` for a missing role, same as today. Company keys are only added when present so JSON never contains them for seekers.)
- Append:

```ts
/** Lets only recruiters whose token carries a company through (after `requireRecruiter`). */
export function requireCompany(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user?.companyId) {
    next(noCompany());
    return;
  }
  next();
}
```

`src/routes/job.routes.ts`:
- Import `requireCompany` with `requireRecruiter`.
- Signature: `export function createJobRoutes(jobPosting: JobPostingCaller): Router {`
- `const recruiter = (req: Request): RecruiterCaller => ({ userId: req.user!.id, companyId: req.user!.companyId! });`
- `mine.use(requireRecruiter);` → `mine.use(requireRecruiter, requireCompany);`
- In `mine.get('/')`: `company_id: req.user!.companyId!,`
- Replace the `/company` handler with:

```ts
  mine.get('/company', (req, res) => {
    const { companyId, companyName } = req.user!;
    res.json(companyName ? { companyId, companyName } : { companyId });
  });
```
- Update the doc comment of the recruiter section if it mentions a configured company.

`src/app.ts`: delete `recruiterCompanyId` from `AppDependencies` (and its doc comment); mount `createJobRoutes(deps.jobPosting)`.

`src/server.ts`: delete the `recruiterCompanyId: config.recruiterCompanyId,` line.

`src/config/env.ts`: delete the `recruiterCompanyId` field (and doc comment) from `GatewayConfig` and the `recruiterCompanyId: …` line from `loadConfig`.

`.env.example`: delete the `DEV_RECRUITER_COMPANY_ID` line and its comment.

`README.md`:
- Delete the `DEV_RECRUITER_COMPANY_ID` row of the env table.
- Route table row: `| GET /api/jobs/mine/company | – (returns { "companyId": …, "companyName": … } from the token) |` (keep the table's backtick style).
- In the section that explains the gateway steps, after step 2 add: `For recruiters, the company comes from the token too: app_metadata.company_id (set by the Supabase signup trigger) is sent to Job Posting as x-company-id; a recruiter token without it gets 403 NO_COMPANY.`
- Errors table: add `| 403 | NO_COMPANY | a recruiter token has no company_id (sign in again after running the Supabase SQL) |`.

- [ ] **Step 5: Run tests**

Run: `npm test && npm run typecheck && grep -rn "DEV_RECRUITER_COMPANY_ID\|recruiterCompanyId\|co-test" src tests README.md .env.example || echo CLEAN`
Expected: all tests pass, typecheck clean, `CLEAN`.

- [ ] **Step 6: Commit**

```bash
git add src tests README.md .env.example
git commit -m "feat: take the recruiter company id from the Supabase token instead of a mock

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Frontend — display readable company ids

Repo: `/Users/nif/dev/SoftwareArchitecture/RoleFit/rolefit-frontend`

**Files:**
- Modify: `src/lib/companies.ts`, `src/lib/companies.test.ts`, `src/lib/api/job-posting.ts`, `src/lib/api/job-posting.test.ts`

**Interfaces:**
- Produces: `initialsOf(name: string): string`; `companyFor(id)` decodes `co-<slug>-<6hex>`; `getRecruiterCompany()` prefers the gateway's `companyName`.

- [ ] **Step 1: Write failing tests**

Append to the `describe("companyFor", …)` block in `src/lib/companies.test.ts`, and add `initialsOf` to the import:

```ts
  it("turns a readable company id back into a name", () => {
    expect(companyFor("co-acme-corp-7f3a9c")).toEqual({ id: "co-acme-corp-7f3a9c", name: "Acme Corp", initials: "AC", color: "#475569" });
  });

  it("shows a generic name for a company whose name had no Latin letters", () => {
    expect(companyFor("co-company-0a1b2c").name).toBe("Company");
  });

  it("keeps the neutral fallback for ids without the 6-hex suffix", () => {
    expect(companyFor("co-acme").name).toBe("co-acme");
  });
});

describe("initialsOf", () => {
  it("uses the first letters of the first two words", () => {
    expect(initialsOf("Acme Corp")).toBe("AC");
    expect(initialsOf("  brightline  ")).toBe("B");
    expect(initialsOf("บริษัท ไทย")).toBe("บไ");
    expect(initialsOf("")).toBe("?");
  });
```
(Replace the file's final `});` accordingly so both `describe` blocks are closed.)

In `src/lib/api/job-posting.test.ts`, replace the `"gets the recruiter company from the gateway"` test with:

```ts
  it("gets the recruiter company from the gateway, preferring its company name", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(200, { companyId: "co-acme-corp-7f3a9c", companyName: "บริษัท แอคมี" }));
    const company = await jobsApi.getRecruiterCompany();
    expect(fetchMock.mock.calls[0][0]).toBe(`${GW}/api/jobs/mine/company`);
    expect(company).toMatchObject({ id: "co-acme-corp-7f3a9c", name: "บริษัท แอคมี", initials: "บแ" });

    fetchMock.mockImplementation(async () => jsonResponse(200, { companyId: "co-acme-corp-7f3a9c" }));
    expect((await jobsApi.getRecruiterCompany()).name).toBe("Acme Corp");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/companies.test.ts src/lib/api/job-posting.test.ts`
Expected: FAIL — `initialsOf` not exported; readable id not decoded; `companyName` ignored.

- [ ] **Step 3: Implement `src/lib/companies.ts`**

Replace the comment above `companies` with:

```ts
// No service owns company data yet. Demo companies (used by the Job Posting
// seed) have display details here. Real recruiters get a readable id at signup
// from the Supabase trigger, "co-<slug>-<6 hex>", which companyFor turns back
// into a name.
```

Replace everything from `const FALLBACK_COLOR` to the end of the file with:

```ts
const FALLBACK_COLOR = "#475569";
const READABLE_ID = /^co-([a-z0-9]+(?:-[a-z0-9]+)*)-[0-9a-f]{6}$/;

/** First letters of the first two words, upper-cased; "?" when there are none. */
export function initialsOf(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => Array.from(word)[0]);
  return letters.join("").toUpperCase() || "?";
}

const titleCase = (slug: string) =>
  slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

/** The company for an id: a demo company, a name decoded from a readable id, or a neutral placeholder. */
export function companyFor(id: string): Company {
  const known = companies.find((c) => c.id === id);
  if (known) return known;

  const readable = READABLE_ID.exec(id);
  if (readable) {
    const name = titleCase(readable[1]);
    return { id, name, initials: initialsOf(name), color: FALLBACK_COLOR };
  }

  return {
    id,
    name: id,
    initials: id.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase() || "?",
    color: FALLBACK_COLOR,
  };
}
```

- [ ] **Step 4: Implement `getRecruiterCompany` in `src/lib/api/job-posting.ts`**

Change the import to `import { companyFor, initialsOf } from "@/lib/companies";` and replace the function with:

```ts
/** The signed-in recruiter's company. The gateway reads it from the Supabase token. */
export async function getRecruiterCompany(): Promise<Company> {
  const { companyId, companyName } = await request<{ companyId: string; companyName?: string }>("GET", "/mine/company");
  const company = companyFor(companyId);
  return companyName ? { ...company, name: companyName, initials: initialsOf(companyName) } : company;
}
```

- [ ] **Step 5: Run tests and lint**

Run: `npm test && npm run lint`
Expected: all pass, lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/companies.ts src/lib/companies.test.ts src/lib/api/job-posting.ts src/lib/api/job-posting.test.ts
git commit -m "feat: show real recruiter company names from readable company ids

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — Supabase SQL and unique-name check at signup

Repo: `/Users/nif/dev/SoftwareArchitecture/RoleFit/rolefit-frontend`

**Files:**
- Modify: `supabase/auth-setup.sql`, `src/lib/auth/role-context.tsx` (signUp only), `README.md`
- Create: `supabase/backfill-company-ids.sql`, `src/lib/auth/company.ts`, `src/lib/auth/company.test.ts`

**Interfaces:**
- Produces: SQL functions `public.normalize_company_name(text)`, `public.company_slug(text)`, `public.company_name_taken(name text)`; trigger sets `app_metadata.company_id` / `company_name`; `isCompanyNameTaken(name: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test `src/lib/auth/company.test.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCompanyNameTaken } from "./company";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/auth/supabase", () => ({ supabase: { rpc } }));

beforeEach(() => rpc.mockReset());

describe("isCompanyNameTaken", () => {
  it("asks Supabase whether a recruiter already registered the name", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(isCompanyNameTaken("Acme Corp")).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith("company_name_taken", { name: "Acme Corp" });
  });

  it("returns false for a free name", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(isCompanyNameTaken("New Co")).resolves.toBe(false);
  });

  it("throws when the check itself fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "function not found" } });
    await expect(isCompanyNameTaken("Acme Corp")).rejects.toThrow("function not found");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/auth/company.test.ts`
Expected: FAIL — cannot resolve `./company`.

- [ ] **Step 3: Create `src/lib/auth/company.ts`**

```ts
import { supabase } from "@/lib/auth/supabase";

/**
 * Whether a recruiter already registered this company name (case- and
 * whitespace-insensitive). Calls the `company_name_taken` database function from
 * supabase/auth-setup.sql; the signup trigger enforces the same rule.
 */
export async function isCompanyNameTaken(name: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("company_name_taken", { name });
  if (error) throw new Error(error.message);
  return data === true;
}
```

- [ ] **Step 4: Use it in `signUp` (`src/lib/auth/role-context.tsx`)**

Add `import { isCompanyNameTaken } from "@/lib/auth/company";`. At the start of the `signUp` callback body, before `supabase.auth.signUp`, insert:

```ts
    if (role === "recruiter" && company) {
      try {
        if (await isCompanyNameTaken(company)) return "This company is already registered.";
      } catch {
        return "Can't check the company name right now. Please try again.";
      }
    }
```
Change the comment above `options:` to `// Lands in user_metadata. The database trigger copies role (and, for recruiters, company_id / company_name) into app_metadata.` Nothing else in the file changes.

- [ ] **Step 5: Run tests and lint**

Run: `npm test && npm run lint`
Expected: all pass, lint clean.

- [ ] **Step 6: Replace `supabase/auth-setup.sql`**

```sql
-- RoleFit Auth project - role and company setup
--
-- Run in the SQL Editor of the Supabase project used for authentication
-- (the separate Auth project, not the Candidate Profile DB project). Safe to re-run.
--
-- The frontend signs up with:
--   supabase.auth.signUp({ email, password, options: { data: { role, name, company } } })
-- `data` lands in raw_user_meta_data, which the user can change later, so it is
-- not trusted. This trigger copies the role - and for recruiters a new company id
-- and the company name - into raw_app_meta_data once, at sign-up. Only the server
-- can write app_metadata, so these JWT claims cannot be changed by the user.
--
-- Recruiter companies: one company per recruiter account. The id is readable but
-- unguessable, e.g. "Acme Corp" -> co-acme-corp-7f3a9c. Company names are unique
-- among recruiters (case- and whitespace-insensitive).

create or replace function public.normalize_company_name(name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(trim(regexp_replace(coalesce(name, ''), '\s+', ' ', 'g')));
$$;

create or replace function public.company_slug(name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    nullif(left(trim(both '-' from regexp_replace(lower(coalesce(name, '')), '[^a-z0-9]+', '-', 'g')), 40), ''),
    'company'
  );
$$;

-- Lets the register page tell a recruiter the name is taken before signing up.
create or replace function public.company_name_taken(name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.users u
    where u.raw_app_meta_data ->> 'role' = 'recruiter'
      and public.normalize_company_name(u.raw_app_meta_data ->> 'company_name') = public.normalize_company_name(name)
  );
$$;

revoke all on function public.company_name_taken(text) from public;
grant execute on function public.company_name_taken(text) to anon, authenticated;

create or replace function public.set_role_on_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_role text := new.raw_user_meta_data ->> 'role';
  company text := trim(coalesce(new.raw_user_meta_data ->> 'company', ''));
  extra jsonb := '{}'::jsonb;
begin
  if requested_role is null or requested_role not in ('seeker', 'recruiter') then
    raise exception 'role must be "seeker" or "recruiter"';
  end if;

  if requested_role = 'recruiter' then
    if company = '' then
      raise exception 'company is required for recruiters';
    end if;
    if public.company_name_taken(company) then
      raise exception 'company already registered';
    end if;
    extra := jsonb_build_object(
      'company_id', 'co-' || public.company_slug(company) || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6),
      'company_name', company
    );
  end if;

  new.raw_app_meta_data :=
    coalesce(new.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', requested_role) || extra;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_set_role on auth.users;

create trigger on_auth_user_created_set_role
  before insert on auth.users
  for each row execute function public.set_role_on_signup();
```

- [ ] **Step 7: Create `supabase/backfill-company-ids.sql`**

```sql
-- One-time backfill: give recruiters who signed up before company ids existed a
-- company_id and company_name. Run AFTER auth-setup.sql. Safe to re-run (only
-- touches recruiters without a company_id). Existing duplicate names are kept as
-- separate companies. Affected users must sign out and in again to get the new claims.

update auth.users u
set raw_app_meta_data =
  coalesce(u.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object(
    'company_id', 'co-' || public.company_slug(u.raw_user_meta_data ->> 'company') || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6),
    'company_name', coalesce(nullif(trim(u.raw_user_meta_data ->> 'company'), ''), 'Company')
  )
where u.raw_app_meta_data ->> 'role' = 'recruiter'
  and coalesce(u.raw_app_meta_data ->> 'company_id', '') = '';

-- Check the result:
select email, raw_app_meta_data ->> 'company_id' as company_id, raw_app_meta_data ->> 'company_name' as company_name
from auth.users
where raw_app_meta_data ->> 'role' = 'recruiter';
```

- [ ] **Step 8: README section**

In `README.md`, after the Environment section, add:

````markdown
## Supabase setup (Auth project)

Run in the Supabase SQL Editor:

1. `supabase/auth-setup.sql` — role + recruiter company trigger and the `company_name_taken` check (safe to re-run).
2. `supabase/backfill-company-ids.sql` — once, to give recruiters registered before company ids a company. They must sign in again afterwards.

Each recruiter account gets its own company (`co-<name>-<6 hex>`, e.g. `co-acme-corp-7f3a9c`); company names are unique.
````

- [ ] **Step 9: Commit**

```bash
git add supabase src/lib/auth/company.ts src/lib/auth/company.test.ts src/lib/auth/role-context.tsx README.md
git commit -m "feat: issue a unique company id per recruiter at Supabase signup

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend — smoke test without the mock company

Repo: `/Users/nif/dev/SoftwareArchitecture/RoleFit/rolefit-frontend`

**Files:**
- Modify: `scripts/e2e-smoke.ts`, `README.md` (e2e row)

- [ ] **Step 1: Update the script**

- Delete the header comment line about `SMOKE_COMPANY_ID` and the line `const COMPANY = process.env.SMOKE_COMPANY_ID ?? "co-brightline";`.
- Replace the step `"jobs: recruiter list includes own drafts; public list is OPEN only"` with:

```ts
  let companyId = "";
  await step("jobs: recruiter has a real company; own list holds only its jobs; public list is OPEN only", async () => {
    const company = await jobs.getRecruiterCompany();
    companyId = company.id;
    expect(/^co-[a-z0-9-]+-[0-9a-f]{6}$/.test(companyId), `unexpected company id ${companyId} (run the Supabase SQL and sign in again)`);
    const mine = await jobs.listMyJobs();
    expect(mine.every((j) => j.companyId === companyId), "other company in own list");
    const open = await jobs.listOpenJobs();
    expect(open.length > 0 && open.every((j) => j.status === "OPEN"), "public list not OPEN only");
    const q = await jobs.listOpenJobs({ query: "react" });
    expect(q.length > 0, "query returned nothing");
  });
```
- In the step `"jobs: create draft, publish needs full details, then publishes"`, right after `jobId = draft.id;` add:

```ts
    expect(draft.companyId === companyId, `draft company ${draft.companyId}`);
    expect((await jobs.listMyJobs({ status: "DRAFT" })).some((j) => j.id === jobId), "new draft missing from own list");
```

- [ ] **Step 2: README e2e row**

In the Scripts table row for `npx tsx scripts/e2e-smoke.ts`, delete the text `, optional `SMOKE_COMPANY_ID` (default `co-brightline`; must equal the gateway's `DEV_RECRUITER_COMPANY_ID`)` and add after the account list: `(the recruiter must have a company id — see Supabase setup)`.

- [ ] **Step 3: Check**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint && npm test && grep -rn "SMOKE_COMPANY_ID\|co-brightline\|DEV_RECRUITER" scripts README.md || echo CLEAN`
Expected: all pass and `CLEAN` (the demo catalog in `src/lib/companies.ts` legitimately still contains `co-brightline`; it is not searched here).

- [ ] **Step 4: Commit**

```bash
git add scripts/e2e-smoke.ts README.md
git commit -m "test: smoke test uses the recruiter's real company id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Live verification (controller + user)

- [ ] User runs `supabase/auth-setup.sql`, then `supabase/backfill-company-ids.sql` in the Supabase SQL editor and checks the result query shows a `company_id` for the test recruiter.
- [ ] Remove the leftover `DEV_RECRUITER_COMPANY_ID` line from the local gateway `.env` (not tracked), restart the gateway.
- [ ] Run `npx tsx scripts/e2e-smoke.ts` in the frontend → `ALL PASSED` (the script signs in fresh, so the token carries the new claims).
- [ ] Register a new recruiter with a taken company name in the browser → "This company is already registered."
