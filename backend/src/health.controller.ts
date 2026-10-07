import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './common/public.decorator';
import { DatabaseService } from './database/database.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Public()
  @SkipThrottle()
  @Get()
  async health() {
    await this.db.query('SELECT 1');
    return { status: 'ok' };
  }
}
