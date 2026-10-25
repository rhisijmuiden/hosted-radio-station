export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const forbidden = (message = 'You do not have access to this resource') =>
  new HttpError(403, 'forbidden', message);
export const unauthorized = () => new HttpError(401, 'unauthorized', 'Authentication required');
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);

/** Postgres unique_violation, also when wrapped in a DrizzleQueryError. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}
