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
    // Unknown error: log it fully, but never leak internals to the client.
    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    return res.status(500).json({ statusCode: 500, code: 'INTERNAL_ERROR', message: 'Something went wrong' });
  }
}
