import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { grpcErrorToAppError } from './grpc-errors';

const DEADLINE_MS = 5000;
const PROTO_PATH = path.join(__dirname, '..', '..', 'proto', 'job-posting.proto');

/** A proto message as a plain object (snake_case keys, enum names as strings). */
export type JobMessage = Record<string, unknown>;

/** Recruiter identity, sent as the `x-user-id` / `x-company-id` metadata. */
export interface RecruiterCaller {
  userId: string;
  companyId: string;
}

/** Calls one unary Job Posting RPC. Rejects only with an AppError, never a raw gRPC error. */
export type JobPostingCaller = <T = JobMessage>(method: string, request: object, caller?: RecruiterCaller) => Promise<T>;

type UnaryMethod = (
  request: object,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (err: grpc.ServiceError | null, response: unknown) => void,
) => void;

/** One channel to the Job Posting Service for the whole process. */
export function createJobPostingCaller(url: string, deadlineMs = DEADLINE_MS): JobPostingCaller {
  const definition = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    rolefit: { jobposting: { v1: { JobPostingService: grpc.ServiceClientConstructor } } };
  };
  const Client = loaded.rolefit.jobposting.v1.JobPostingService;
  const client = new Client(url, grpc.credentials.createInsecure()) as grpc.Client & Record<string, UnaryMethod>;

  return <T>(method: string, request: object, caller?: RecruiterCaller) =>
    new Promise<T>((resolve, reject) => {
      const metadata = new grpc.Metadata();
      if (caller) {
        metadata.set('x-user-id', caller.userId);
        metadata.set('x-company-id', caller.companyId);
      }
      client[method](request, metadata, { deadline: Date.now() + deadlineMs }, (err, response) => {
        if (err) reject(grpcErrorToAppError(err));
        else resolve(response as T);
      });
    });
}
