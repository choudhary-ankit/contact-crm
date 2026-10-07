import { Transform, Type } from 'class-transformer';
import { ATTENTION_FILTERS, Attention } from '../attention';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min, MinLength,
} from 'class-validator';

export const SORT_FIELDS = ['name', 'createdAt', 'deletedAt'] as const;
export type SortField = (typeof SORT_FIELDS)[number];

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() || undefined : value));

export class ListContactsQuery {
  /** Substring search over name, email and phone. Min 2 chars keeps trigram lookups selective. */
  @trim() @IsOptional() @IsString() @MinLength(2) @MaxLength(100)
  q?: string;

  /** Comma separated tag names; a contact matches if it has ANY of them. */
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value,
  )
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true })
  tags?: string[];

  @trim() @IsOptional() @IsString() @MaxLength(150)
  company?: string;

  /** Data-quality filter used by the Metrics page links. Active contacts only. */
  @IsOptional() @IsIn(ATTENTION_FILTERS)
  attention?: Attention;

  @IsOptional() @IsISO8601()
  createdFrom?: string;

  @IsOptional() @IsISO8601()
  createdTo?: string;

  /** 'active' (default) or 'deleted' (the trash). */
  @IsOptional() @IsIn(['active', 'deleted'])
  status: 'active' | 'deleted' = 'active';

  /** Defaults to createdAt for active contacts and deletedAt for the trash; deletedAt is trash-only. */
  @IsOptional() @IsIn(SORT_FIELDS)
  sort?: SortField;

  @IsOptional() @IsIn(['asc', 'desc'])
  order: 'asc' | 'desc' = 'desc';

  @Type(() => Number) @IsOptional() @IsInt() @Min(1) @Max(100)
  limit: number = 25;

  @IsOptional() @IsString() @MaxLength(500)
  cursor?: string;
}
