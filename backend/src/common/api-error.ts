import { HttpException } from '@nestjs/common';

export interface FieldError {
  field: string;
  message: string;
}

/** Every non-2xx response has the shape { statusCode, code, message, details?, current? }. */
export class ApiError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
    public readonly extra: { details?: FieldError[]; current?: unknown; existing?: { id: string; name: string } } = {},
  ) {
    super({ statusCode: status, code, message, ...extra }, status);
  }
}

export const notFound = (what = 'Contact') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
