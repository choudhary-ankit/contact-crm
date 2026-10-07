import {
  Controller, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseInterceptors, Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { AccountId } from '../common/account.decorator';
import { ApiError } from '../common/api-error';
import { loadConfig } from '../config';
import { FORMATS } from './formats';
import { ImportsService } from './imports.service';

const writeLimit = () => Throttle({ default: { limit: () => loadConfig().writeRateLimitPerMin, ttl: 60_000 } });
const validation = (field: string, message: string) => new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', { details: [{ field, message }] });

const CSV_TYPES = new Set(['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain', 'application/octet-stream']);

@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  /** Column specs + notes for both formats (drives the format guide in the UI). */
  @Get('formats')
  formats() {
    return Object.values(FORMATS).map(({ sample: _s, ...spec }) => spec);
  }

  @Get('templates/:mode')
  template(@Param('mode') mode: string, @Res() res: Response) {
    const spec = FORMATS[mode as 'create' | 'update'];
    if (!spec) throw new ApiError(404, 'NOT_FOUND', 'Unknown template');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${spec.filename}"`);
    res.send(spec.sample);
  }

  @Get()
  list(@AccountId() account: string, @Query('limit', new ParseIntPipe({ optional: true })) limit = 50) {
    return this.imports.list(account, Math.min(Math.max(limit, 1), 100)).then((data) => ({ data }));
  }

  /** Accepts the file and returns immediately (202); a background worker validates it. */
  @Post()
  @HttpCode(202)
  @writeLimit()
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: loadConfig().importMaxBytes, files: 1 } }))
  async upload(@AccountId() account: string, @UploadedFile() file: Express.Multer.File | undefined, @Body('mode') mode?: string) {
    if (mode !== 'create' && mode !== 'update') throw validation('mode', 'mode must be "create" or "update"');
    if (!file) throw validation('file', 'Choose a .csv file to upload');
    const name = file.originalname || 'upload.csv';
    if (!/\.csv$/i.test(name) || !CSV_TYPES.has(file.mimetype)) throw validation('file', 'Upload a .csv file');
    if (!file.size) throw validation('file', 'The file is empty');
    if (file.buffer.includes(0)) throw validation('file', 'This does not look like a text CSV file');
    return this.imports.createJob(account, mode, name, file.buffer);
  }

  @Get(':id')
  get(@AccountId() account: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.get(account, id);
  }

  @Get(':id/errors')
  errors(
    @AccountId() account: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 100,
    @Query('offset', new ParseIntPipe({ optional: true })) offset = 0,
  ) {
    return this.imports.errors(account, id, Math.min(Math.max(limit, 1), 500), Math.max(offset, 0));
  }

  @Get(':id/errors.csv')
  async errorsCsv(@AccountId() account: string, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { filename, body } = await this.imports.errorsCsv(account, id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(body);
  }

  @Post(':id/confirm')
  @HttpCode(202)
  @writeLimit()
  confirm(@AccountId() account: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.confirm(account, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @writeLimit()
  cancel(@AccountId() account: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.cancel(account, id);
  }
}
