import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf } from 'class-validator';

const TagName = () => (target: object, key: string) => {
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))(target, key);
  IsString()(target, key);
  IsNotEmpty()(target, key);
  MaxLength(50)(target, key);
  Matches(/^[^,]+$/, { message: 'tag name cannot contain commas' })(target, key);
};

export class AddTagDto {
  /** A single tag (kept for compatibility). Send `names` to add several at once. */
  @ValidateIf((o) => o.names === undefined) @TagName()
  name?: string;

  /** Several tags in one request: added together in one transaction. */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20)
  @Transform(({ value }) => (Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim() : v)) : value))
  @IsString({ each: true }) @IsNotEmpty({ each: true }) @MaxLength(50, { each: true })
  @Matches(/^[^,]+$/, { each: true, message: 'tag names cannot contain commas' })
  names?: string[];
}

export class BulkTagDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @IsUUID('all', { each: true })
  contactIds: string[];

  @TagName() tag: string;
}

export class BulkDeleteDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(1000) @IsUUID('all', { each: true })
  contactIds: string[];
}
