import { Module } from '@nestjs/common';
import { TagsController } from '../tags/tags.controller';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';

@Module({ controllers: [ContactsController, TagsController], providers: [ContactsService] })
export class ContactsModule {}
