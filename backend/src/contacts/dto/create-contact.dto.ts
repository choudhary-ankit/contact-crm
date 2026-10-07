import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { IsPhone, TrimLower, TrimToNull } from './validators';

export class CreateContactDto {
  @TrimToNull() @IsString() @IsNotEmpty() @MaxLength(100)
  firstName: string;

  @TrimToNull() @IsString() @IsNotEmpty() @MaxLength(100)
  lastName: string;

  @TrimLower() @IsOptional() @IsEmail() @MaxLength(254)
  email?: string | null;

  @TrimToNull() @IsOptional() @IsPhone()
  phone?: string | null;

  @TrimToNull() @IsOptional() @IsString() @MaxLength(150)
  company?: string | null;

  /** Optional initial tags (names). Created on the fly, case-insensitively unique per account. */
  @Transform(({ value }) =>
    Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim() : v)).filter((v) => v !== '') : value,
  )
  @IsOptional() @IsArray() @ArrayMaxSize(20)
  @IsString({ each: true }) @IsNotEmpty({ each: true }) @MaxLength(50, { each: true })
  @Matches(/^[^,]+$/, { each: true, message: 'tag names cannot contain commas' })
  tags?: string[];
}
