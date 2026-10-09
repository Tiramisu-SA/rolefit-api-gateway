import { status } from '@grpc/grpc-js';
import { AppError, serviceUnavailable, type FieldError } from '../utils/errors';
import { logger } from '../utils/logger';

export interface GrpcLikeError {
  code?: number;
  details?: string;
  metadata?: { get(key: string): unknown[] };
}

/** The Job Posting Service puts field errors as JSON in the `x-validation-errors` trailer. */
function readFieldErrors(err: GrpcLikeError): FieldError[] | undefined {
  const [raw] = err.metadata?.get('x-validation-errors') ?? [];
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FieldError[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A gRPC error from the Job Posting Service → an HTTP AppError. Client errors
 * keep the service's message; unexpected errors are logged and hidden.
 */
export function grpcErrorToAppError(err: GrpcLikeError): AppError {
  const details = err.details || 'The job service returned an error';
  switch (err.code) {
    case status.INVALID_ARGUMENT:
      return new AppError(details, 400, 'VALIDATION_ERROR', readFieldErrors(err));
    case status.NOT_FOUND:
      return new AppError(details, 404, 'NOT_FOUND');
    case status.FAILED_PRECONDITION:
      return new AppError(details, 409, 'INVALID_STATE');
    case status.PERMISSION_DENIED:
      return new AppError(details, 403, 'FORBIDDEN');
    case status.UNAUTHENTICATED:
      return new AppError(details, 401, 'UNAUTHENTICATED');
    case status.UNAVAILABLE:
    case status.DEADLINE_EXCEEDED:
      return serviceUnavailable('job posting');
    default:
      logger.error('Unexpected Job Posting gRPC error', err.code, err.details);
      return new AppError('Something went wrong with the job service. Please try again.', 500, 'INTERNAL_ERROR');
  }
}
