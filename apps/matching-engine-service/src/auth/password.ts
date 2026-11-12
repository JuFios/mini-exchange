import { registerDecorator } from 'class-validator';

// bcrypt читає лише перші 72 байти ключа, решту мовчки відкидає.
export const PASSWORD_MAX_BYTES = 72;

export const passwordFitsBcrypt = (password: string) =>
  Buffer.byteLength(password, 'utf8') <= PASSWORD_MAX_BYTES;

// Неспарену половину UTF-16 bcrypt отримує як U+FFFD: різні такі паролі дали б один хеш.
export const passwordIsWellFormed = (password: string) => !/\p{Cs}/u.test(password);

function stringRule(name: string, check: (value: string) => boolean) {
  return (message: string): PropertyDecorator =>
    (target, property) => {
      registerDecorator({
        name,
        target: target.constructor,
        propertyName: String(property),
        options: { message },
        validator: {
          // Тип перевіряють інші валідатори; тут лише вміст рядка.
          validate: (value: unknown) => typeof value !== 'string' || check(value),
        },
      });
    };
}

export const FitsBcrypt = stringRule('fitsBcrypt', passwordFitsBcrypt);
export const IsWellFormedPassword = stringRule('isWellFormedPassword', passwordIsWellFormed);
