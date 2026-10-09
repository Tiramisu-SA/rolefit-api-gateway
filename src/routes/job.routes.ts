import express, { Router, type Request } from 'express';
import type { JobPostingCaller, RecruiterCaller } from '../grpc/job-posting.client';
import { requireRecruiter } from '../middleware/auth.middleware';

const LIST_LIMIT = 100;
// Job Posting accepts templates up to 2 MB; the extra room lets it answer with its own message.
const MAX_TEMPLATE_BYTES = 3 * 1024 * 1024;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function decodeFileName(header: string | undefined): string {
  if (!header) return '';
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

/**
 * REST → gRPC translation for the Job Posting Service, mounted at /api/jobs.
 * Request bodies and responses are proto-shaped (snake_case, prefixed enums)
 * and passed through unchanged: the service does all validation and rules.
 */
export function createJobRoutes(jobPosting: JobPostingCaller, recruiterCompanyId: string): Router {
  const router = Router();
  const json = express.json({ limit: '1mb' });
  const raw = express.raw({ type: () => true, limit: MAX_TEMPLATE_BYTES });
  const recruiter = (req: Request): RecruiterCaller => ({ userId: req.user!.id, companyId: recruiterCompanyId });

  // --- recruiter: own company's jobs (mounted before /:jobId so "mine" is never a job id) ---
  const mine = Router();
  mine.use(requireRecruiter);

  mine.get('/', async (req, res) => {
    const request = {
      company_id: recruiterCompanyId,
      status: text(req.query.status) || 'JOB_STATUS_UNSPECIFIED',
      query: text(req.query.query),
      limit: LIST_LIMIT,
    };
    res.json(await jobPosting('ListJobs', request, recruiter(req)));
  });

  mine.get('/company', (_req, res) => {
    res.json({ companyId: recruiterCompanyId });
  });

  mine.post('/', json, async (req, res) => {
    res.json(await jobPosting('CreateJob', { job: req.body }, recruiter(req)));
  });

  mine.get('/:jobId', async (req, res) => {
    res.json(await jobPosting('GetJob', { job_id: req.params.jobId }, recruiter(req)));
  });

  mine.put('/:jobId', json, async (req, res) => {
    res.json(await jobPosting('UpdateJob', { job_id: req.params.jobId, job: req.body }, recruiter(req)));
  });

  mine.delete('/:jobId', async (req, res) => {
    await jobPosting('DeleteJob', { job_id: req.params.jobId }, recruiter(req));
    res.status(204).end();
  });

  const transitions = [
    ['publish', 'PublishJob'],
    ['close', 'CloseJob'],
    ['reopen', 'ReopenJob'],
  ] as const;
  for (const [action, method] of transitions) {
    mine.post(`/:jobId/${action}`, async (req, res) => {
      res.json(await jobPosting(method, { job_id: req.params.jobId }, recruiter(req)));
    });
  }

  mine.get('/:jobId/resume-template', async (req, res) => {
    res.json(await jobPosting('GetResumeTemplate', { job_id: req.params.jobId, include_content: false }, recruiter(req)));
  });

  mine.put('/:jobId/resume-template', raw, async (req, res) => {
    const request = {
      job_id: req.params.jobId,
      file_name: decodeFileName(req.get('x-file-name')),
      content_type: req.get('content-type') ?? '',
      content: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    };
    res.json(await jobPosting('AttachResumeTemplate', request, recruiter(req)));
  });

  mine.delete('/:jobId/resume-template', async (req, res) => {
    await jobPosting('DeleteResumeTemplate', { job_id: req.params.jobId }, recruiter(req));
    res.status(204).end();
  });

  router.use('/mine', mine);

  // --- any signed-in user: no identity is sent, so drafts are never returned ---
  router.get('/', async (req, res) => {
    res.json(await jobPosting('ListJobs', { status: 'JOB_STATUS_OPEN', query: text(req.query.query), limit: LIST_LIMIT }));
  });

  router.get('/:jobId', async (req, res) => {
    res.json(await jobPosting('GetJob', { job_id: req.params.jobId }));
  });

  return router;
}
