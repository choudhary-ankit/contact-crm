import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'crypto';
import { loadConfig } from '../config';
import { ApiError } from './api-error';
import { IS_PUBLIC } from './public.decorator';

const sha = (s: string) => createHash('sha256').update(s).digest();

/**
 * Demo-grade authentication: "Authorization: Bearer <api key>", each key bound to one account.
 * The account id becomes the tenant scope for every query. See README for the production path (OIDC/JWT + RBAC).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (match) {
      const presented = sha(match[1]);
      for (const [key, accountId] of loadConfig().apiKeys) {
        // constant-time compare of fixed-length digests
        if (timingSafeEqual(presented, sha(key))) {
          req.accountId = accountId;
          return true;
        }
      }
    }
    throw new ApiError(401, 'UNAUTHORIZED', 'Missing or invalid API key');
  }
}
