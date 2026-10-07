import { Transform } from 'class-transformer';
import { registerDecorator, ValidationOptions } from 'class-validator';

/** Trim strings; empty string becomes null (so "clear this field" and "blank input" mean the same thing). */
export const TrimToNull = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() || null : value));

export const TrimLower = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() || null : value));

/** 7-15 digits with optional leading + and common separators. */
export function IsPhone(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isPhone',
      target: object.constructor,
      propertyName,
      options: { message: 'phone must be 7-15 digits and may contain + ( ) - . and spaces', ...options },
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string') return false;
          if (!/^\+?[\d\s().-]+$/.test(value)) return false;
          const digits = value.replace(/\D/g, '').length;
          return digits >= 7 && digits <= 15;
        },
      },
    });
}
