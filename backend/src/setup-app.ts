import { INestApplication, ValidationError, ValidationPipe } from '@nestjs/common';
import { ApiError, FieldError } from './common/api-error';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { loadConfig } from './config';

function flatten(errors: ValidationError[], prefix = ''): FieldError[] {
  return errors.flatMap((e) => {
    const field = prefix ? `${prefix}.${e.property}` : e.property;
    // one message per field is enough for a form; the first constraint is the most relevant
    const first = Object.values(e.constraints ?? {})[0];
    const own = first ? [{ field, message: first }] : [];
    return [...own, ...flatten(e.children ?? [], field)];
  });
}

/** Shared by main.ts and the e2e tests so tests exercise the real pipeline. */
export function setupApp(app: INestApplication) {
  // Behind a hosting proxy every request arrives from the proxy's IP. Trusting it lets Express read the real client
  // IP from X-Forwarded-For; without this all visitors would share one rate-limit bucket.
  const hops = loadConfig().trustProxy;
  if (hops > 0) app.getHttpAdapter().getInstance().set('trust proxy', hops);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) =>
        new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', { details: flatten(errors) }),
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
}
