import { registerDecorator } from 'class-validator';

// bcrypt читає лише перші 72 байти ключа, решту мовчки відкидає.
export const PASSWORD_MAX_BYTES = 72;

export const passwordFitsBcrypt = (password: string) =>
  Buffer.byteLength(password, 'utf8') <= PASSWORD_MAX_BYTES;

export function FitsBcrypt(message: string): PropertyDecorator {
  return (target, property) => {
    registerDecorator({
      name: 'fitsBcrypt',
      target: target.constructor,
      propertyName: String(property),
      options: { message },
      validator: {
        // Тип перевіряють інші валідатори; тут лише довжина рядка.
        validate: (value: unknown) => typeof value !== 'string' || passwordFitsBcrypt(value),
      },
    });
  };
}
