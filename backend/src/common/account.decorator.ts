import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Account id resolved from the API key by ApiKeyGuard. */
export const AccountId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest().accountId;
});
