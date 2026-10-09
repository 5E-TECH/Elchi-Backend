import { registerDecorator, ValidationOptions } from 'class-validator';
import {
  isKnownNotificationType,
  notificationTypeErrorMessage,
} from './notification-types';

/**
 * (Eh8y21Ha) `type` reyestrda bo'lishi SHART (fail-closed); vaqtinchalik
 * erkin tur faqat `x.` prefiksi bilan. Xato matni ruxsat etilgan prefiksni
 * tushuntiradi.
 */
export function IsNotificationType(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isNotificationType',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && isKnownNotificationType(value),
        defaultMessage: (args) => notificationTypeErrorMessage(args?.value),
      },
    });
  };
}
