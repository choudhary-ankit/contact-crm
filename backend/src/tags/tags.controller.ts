import { Controller, Get, Query } from '@nestjs/common';
import { AccountId } from '../common/account.decorator';
import { ContactsService } from '../contacts/contacts.service';

@Controller('tags')
export class TagsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  async list(@AccountId() account: string, @Query('q') q?: string) {
    return { data: await this.contacts.listTags(account, q?.trim().slice(0, 50) || undefined) };
  }
}
