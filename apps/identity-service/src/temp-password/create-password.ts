import { RpcException } from '@nestjs/microservices';
import {
  PASSWORD_MODES,
  type PasswordMode,
  generateTempPassword,
} from '@app/common';
import { errorRes } from '../../../../libs/common/helpers/response';

/** Yaratish DTO'laridagi parol maydonlari (admin/ro'yxatchi/logist/kuryer/menejer/market). */
export interface CreatePasswordFields {
  password?: string | null;
  password_mode?: string | null;
  must_change_password?: boolean | null;
}

export interface ResolvedCreatePassword {
  mode: PasswordMode;
  /** Hash'lanadigan ochiq parol (faqat xotirada; `generate_sms` da — tizimniki). */
  password: string;
  /** `generate_sms` — yaratilgach SMS yuboriladi. */
  sendSms: boolean;
  /** `admins.must_change_password` (va `password_change_forced`). */
  mustChange: boolean;
}

const badRequest = (message: string): never => {
  throw new RpcException(errorRes(message, 400));
};

/**
 * (aidsxJ2H) Yaratishdagi parol rejimi:
 *  - `password_mode: 'generate_sms'` (SUKUT) — 12 belgili tasodifiy parol
 *    (siyosatga mos), SMS bilan yuboriladi, `must_change_password` DOIM
 *    `true`; `password` yuborilmaydi (yuborilsa 400), javobda parol YO'Q;
 *  - `password_mode: 'manual'` — admin kiritgan `password` (siyosat
 *    chaqiruvchida), SMS yo'q, `must_change_password` ixtiyoriy (sukut false).
 *
 * MOSLIK: `password_mode` berilmagan, lekin `password` bor — `manual`
 * (hozirgi frontend parolni o'zi yuboradi; FE yangi formaga o'tguncha
 * yaratish buzilmasin). Ikkalasi ham yo'q — `generate_sms`.
 */
export function resolveCreatePassword(
  dto: CreatePasswordFields | null | undefined,
  context: { role: string; phone?: string | null },
): ResolvedCreatePassword {
  const rawMode = dto?.password_mode;
  if (
    rawMode !== undefined &&
    rawMode !== null &&
    !(PASSWORD_MODES as readonly string[]).includes(rawMode)
  ) {
    badRequest(`password_mode: ${PASSWORD_MODES.join(' yoki ')}`);
  }
  const mustChangeRaw = dto?.must_change_password;
  if (
    mustChangeRaw !== undefined &&
    mustChangeRaw !== null &&
    typeof mustChangeRaw !== 'boolean'
  ) {
    badRequest("must_change_password: true yoki false bo'lishi kerak");
  }
  const rawPassword = dto?.password;
  const hasPassword = rawPassword !== undefined && rawPassword !== null;
  const mode: PasswordMode =
    (rawMode as PasswordMode | null | undefined) ??
    (hasPassword ? 'manual' : 'generate_sms');

  if (mode === 'generate_sms') {
    if (hasPassword) {
      badRequest(
        'Parolni tizim yaratadi va SMS bilan yuboradi (password_mode: generate_sms) — password yubormang yoki password_mode: manual tanlang',
      );
    }
    if (mustChangeRaw === false) {
      badRequest(
        "Tizim yaratgan parol birinchi kirishda albatta almashtiriladi (must_change_password: false bo'lmaydi)",
      );
    }
    return {
      mode,
      password: generateTempPassword({
        role: context.role,
        phone: context.phone,
      }),
      sendSms: true,
      mustChange: true,
    };
  }

  if (typeof rawPassword !== 'string' || rawPassword.length === 0) {
    badRequest('Parolni kiriting (password_mode: manual)');
  }
  return {
    mode,
    password: rawPassword as string,
    sendSms: false,
    mustChange: mustChangeRaw === true,
  };
}
