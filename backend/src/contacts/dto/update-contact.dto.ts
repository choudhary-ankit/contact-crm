import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { IsPhone, TrimLower, TrimToNull } from './validators';

/**
 * PATCH semantics: a missing key leaves the field untouched, `null` (or "") clears an optional field.
 * firstName/lastName can be changed but never cleared.
 */
export class UpdateContactDto {
  @TrimToNull() @ValidateIf((o) => o.firstName !== undefined) @IsString() @IsNotEmpty() @MaxLength(100)
  firstName?: string;

  @TrimToNull() @ValidateIf((o) => o.lastName !== undefined) @IsString() @IsNotEmpty() @MaxLength(100)
  lastName?: string;

  @TrimLower() @IsOptional() @IsEmail() @MaxLength(254)
  email?: string | null;

  @TrimToNull() @IsOptional() @IsPhone()
  phone?: string | null;

  @TrimToNull() @IsOptional() @IsString() @MaxLength(150)
  company?: string | null;
}
