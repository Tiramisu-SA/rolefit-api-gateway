export interface FieldError {
  field: string;
  message: string;
}

/**
 * Base error type. The error middleware turns it into
 * `{ error: { code, message, details? } }`, the same envelope the services use,
 * so the frontend parses gateway and service errors the same way.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number = 500,
    public readonly code: string = 'INTERNAL_ERROR',
    public readonly details?: FieldError[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export const missingToken = () => new AppError('Missing Authorization: Bearer <token> header', 401, 'MISSING_TOKEN');
export const invalidToken = () => new AppError('Invalid access token', 401, 'INVALID_TOKEN');
export const tokenExpired = () => new AppError('Access token has expired. Please sign in again.', 401, 'TOKEN_EXPIRED');
export const forbidden = (message = 'You do not have access to this resource') => new AppError(message, 403, 'FORBIDDEN');

/** A downstream service is down or timed out. */
export const serviceUnavailable = (service: string) =>
  new AppError(`The ${service} service is unavailable. Please try again.`, 503, 'SERVICE_UNAVAILABLE');
