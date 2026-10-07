import { Module } from '@nestjs/common';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { ImportsWorker } from './imports.worker';

@Module({ controllers: [ImportsController], providers: [ImportsService, ImportsWorker], exports: [ImportsWorker] })
export class ImportsModule {}
