import { Controller, Get, Query } from '@nestjs/common';
import { AccountId } from '../common/account.decorator';
import { ApiError } from '../common/api-error';
import { MetricsService, RANGES, Range } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  get(@AccountId() account: string, @Query('range') raw?: string) {
    const range = raw === undefined ? 30 : Number(raw);
    if (!RANGES.includes(range as Range)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', { details: [{ field: 'range', message: `range must be one of ${RANGES.join(', ')}` }] });
    }
    return this.metrics.get(account, range as Range);
  }
}
