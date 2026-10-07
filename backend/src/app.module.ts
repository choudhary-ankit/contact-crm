import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ApiKeyGuard } from './common/api-key.guard';
import { loadConfig } from './config';
import { ContactsModule } from './contacts/contacts.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { ImportsModule } from './imports/imports.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [
    DatabaseModule,
    ContactsModule,
    ImportsModule,
    MetricsModule,
    // Limits are read when the app is created so they follow env config.
    ThrottlerModule.forRootAsync({
      useFactory: () => [{ ttl: 60_000, limit: loadConfig().rateLimitPerMin }],
    }),
  ],
  controllers: [HealthController],
  providers: [
    // Throttle first (by IP) so unauthenticated floods are limited too, then authenticate.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
  ],
})
export class AppModule {}
