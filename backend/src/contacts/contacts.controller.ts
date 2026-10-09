import {
  Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { toCsvLine } from '../imports/csv';
import { AccountId } from '../common/account.decorator';
import { ApiError } from '../common/api-error';
import { loadConfig } from '../config';
import { ContactsService } from './contacts.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { ListContactsQuery } from './dto/list-contacts.query';
import { AddTagDto, BulkDeleteDto, BulkTagDto } from './dto/tags.dto';
import { UpdateContactDto } from './dto/update-contact.dto';

/** Stricter budget for mutating endpoints. */
const writeLimit = () => Throttle({ default: { limit: () => loadConfig().writeRateLimitPerMin, ttl: 60_000 } });

const setEtag = (res: Response, version: number) => res.setHeader('ETag', `"${version}"`);

/** Accepts `3`, `"3"` and `W/"3"`. */
function parseIfMatch(header: string | undefined): number {
  if (!header) {
    throw new ApiError(428, 'PRECONDITION_REQUIRED', 'If-Match header with the contact version is required to update');
  }
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(header.trim());
  if (!m) throw new ApiError(400, 'BAD_REQUEST', 'If-Match must be the numeric contact version');
  return Number(m[1]);
}

@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  list(@AccountId() account: string, @Query() query: ListContactsQuery) {
    return this.contacts.list(account, query);
  }

  /**
   * Streams the contacts matching the current list filters as CSV (up to 50,000 rows). The columns match the
   * "update existing contacts" import format, so export -> edit -> import works.
   */
  @Get('export.csv')
  async export(@AccountId() account: string, @Query() query: ListContactsQuery, @Res() res: Response) {
    const MAX = 50_000;
    const pageQuery = (cursor?: string) => ({ ...query, status: 'active', limit: 1000, cursor }) as ListContactsQuery;

    let page = await this.contacts.list(account, pageQuery()); // fetch first: validation errors surface as a normal JSON error
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
    res.write('\uFEFF' + toCsvLine(['first_name', 'last_name', 'email', 'phone', 'company', 'tags']));
    let written = 0;
    for (;;) {
      for (const c of page.data) {
        if (written >= MAX || res.destroyed) break;
        res.write(toCsvLine([c.firstName, c.lastName, c.email ?? '', c.phone ?? '', c.company ?? '', c.tags.map((t) => t.name).join(';')]));
        written++;
      }
      if (!page.nextCursor || written >= MAX || res.destroyed) break; // stop querying once the client has gone away
      page = await this.contacts.list(account, pageQuery(page.nextCursor));
    }
    res.end();
  }

  @Post()
  @writeLimit()
  async create(@AccountId() account: string, @Body() dto: CreateContactDto, @Res({ passthrough: true }) res: Response) {
    const created = await this.contacts.create(account, dto);
    setEtag(res, created.version);
    return created;
  }

  // Declared before ':id' routes so "bulk" is never parsed as a contact id.
  @Post('bulk/tags')
  @HttpCode(200)
  @writeLimit()
  bulkAddTag(@AccountId() account: string, @Body() dto: BulkTagDto) {
    return this.contacts.bulkAddTag(account, dto.contactIds, dto.tag);
  }

  @Post('bulk/delete')
  @HttpCode(200)
  @writeLimit()
  bulkDelete(@AccountId() account: string, @Body() dto: BulkDeleteDto) {
    return this.contacts.bulkDelete(account, dto.contactIds);
  }

  @Get(':id')
  async get(@AccountId() account: string, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response) {
    const contact = await this.contacts.get(account, id);
    setEtag(res, contact.version);
    return contact;
  }

  @Patch(':id')
  @writeLimit()
  async update(
    @AccountId() account: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: UpdateContactDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { contact } = await this.contacts.update(account, id, parseIfMatch(ifMatch), dto);
    setEtag(res, contact.version);
    return contact;
  }

  /** Soft delete: moves the contact to the trash. Needs If-Match like an update. */
  @Delete(':id')
  @writeLimit()
  async remove(
    @AccountId() account: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const contact = await this.contacts.softDelete(account, id, parseIfMatch(ifMatch));
    setEtag(res, contact.version);
    return contact;
  }

  @Post(':id/restore')
  @HttpCode(200)
  @writeLimit()
  async restore(
    @AccountId() account: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const contact = await this.contacts.restore(account, id, parseIfMatch(ifMatch));
    setEtag(res, contact.version);
    return contact;
  }

  @Get(':id/activity')
  async activity(
    @AccountId() account: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return { data: await this.contacts.activity(account, id, Math.min(Math.max(limit, 1), 100)) };
  }

  @Post(':id/tags')
  @writeLimit()
  async addTag(
    @AccountId() account: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTagDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const names = dto.names ?? (dto.name ? [dto.name] : []);
    if (!names.length) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', { details: [{ field: 'names', message: 'Send a tag name, or a list of names' }] });
    }
    const result = await this.contacts.addTags(account, id, names);
    res.status(result.added ? 201 : 200); // 200 = every tag was already there (idempotent)
    return result;
  }

  @Delete(':id/tags/:tagId')
  @HttpCode(204)
  @writeLimit()
  async removeTag(
    @AccountId() account: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('tagId', ParseUUIDPipe) tagId: string,
  ) {
    await this.contacts.removeTag(account, id, tagId);
  }
}
