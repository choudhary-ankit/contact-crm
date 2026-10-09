import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Response } from 'express';
import { ApiError } from './api-error';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  429: 'RATE_LIMITED',
};

/** Database overload: no free connection within the wait limit, a statement cancelled by the timeout, or too many connections. */
export const isOverload = (e: unknown): boolean => {
  const err = e as { code?: string; message?: string } | undefined;
  return err?.code === '57014' || err?.code === '53300' || /timeout exceeded when trying to connect/i.test(err?.message ?? '');
};

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ApiError) {
      return res.status(exception.getStatus()).json(exception.getResponse());
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message = typeof body === 'string' ? body : ((body as any).message ?? exception.message);
      return res.status(status).json({
        statusCode: status,
        code: CODE_BY_STATUS[status] ?? 'ERROR',
        message: Array.isArray(message) ? message.join('; ') : message,
      });
    }
    if (isOverload(exception)) {
      this.logger.warn(`Shedding load: ${(exception as Error).message}`);
      res.setHeader('Retry-After', '2');
      return res.status(503).json({ statusCode: 503, code: 'SERVICE_BUSY', message: 'The service is busy right now. Try again in a moment.' });
    }
    // Unknown error: log it fully, but never leak internals to the client.
    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    return res.status(500).json({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong' });
  }
}
