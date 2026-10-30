import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Optional,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { PASSWORD_CHANGE_REQUIRED, isPasswordSwitchOn } from '@app/common';

export const ALLOW_DURING_PASSWORD_CHANGE_KEY = 'allowDuringPasswordChange';

/**
 * (NDmZMzCP / aidsxJ2H) `pwd_change: true` claim'li token bilan ham ochiq
 * route — parol almashtirish oqimi: o'z profili (o'qish / parolni
 * almashtirish), token tekshiruvi, chiqish. Login / refresh `@Public()`.
 */
export const AllowDuringPasswordChange = () =>
  SetMetadata(ALLOW_DURING_PASSWORD_CHANGE_KEY, true);

export const PASSWORD_CHANGE_REQUIRED_MESSAGE =
  'Avval parolingizni almashtiring — yangi parol kamida 8 belgi (xodimlar 10), oddiy parollar taqiqlangan';

/** `PASSWORD_CHANGE_GATE` = `on` / `true` / `1` — darvoza yoqilgan. */
export const isPasswordChangeGateEnabled = isPasswordSwitchOn;

/**
 * (NDmZMzCP, 2026-10-26) Parolni almashtirish shart bo'lgan foydalanuvchi
 * (login paytida eski paroli yangi siyosatga mos kelmagan — identity
 * `must_change_password`, access token'da `pwd_change: true`) faqat parol
 * almashtirish oqimidan foydalana oladi; boshqa har qanday route — 403
 * `PASSWORD_CHANGE_REQUIRED`. Global APP_GUARD — `JwtAuthGuard` dan KEYIN
 * (`req.user` tayyor). `@Public()` route'larda foydalanuvchi yo'q — o'tadi.
 *
 * (aidsxJ2H) `pwd_forced: true` (parolni admin / tizim bergan —
 * `password_mode: 'generate_sms'`, `manual` + `must_change_password`, SMS'ni
 * qayta yuborish) — darvoza `PASSWORD_CHANGE_GATE` ga qaramay YOQIQ.
 *
 * XAVFSIZ YOQISH: `PASSWORD_CHANGE_GATE` (sukut — O'CHIQ). FE'da majburiy
 * «Yangi parol o'rnating» ekrani chiqmaguncha yoqilmaydi — aks holda zaif
 * parolli foydalanuvchilar kirgandan keyin hech narsa qila olmasdi. O'chiq
 * holatda ham bayroq login javobida (`must_change_password`) va tokenda bor.
 */
@Injectable()
export class PasswordChangeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Optional() private readonly config?: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context
      .switchToHttp()
      .getRequest<{ user?: { pwd_change?: unknown; pwd_forced?: unknown } }>();
    if (request?.user?.pwd_change !== true) return true;
    // (aidsxJ2H) Parolni admin / tizim bergan (vaqtinchalik SMS paroli yoki
    // «birinchi kirishda almashtirsin») — darvoza env'ga QARAMAY ishlaydi.
    // Faqat yangi yaratilgan / parolni qayta yuborilgan foydalanuvchilar;
    // NDmZMzCP ning «zaif eski parol» bayrog'i env bilan qoladi.
    const forced = request.user.pwd_forced === true;
    if (
      !forced &&
      !isPasswordChangeGateEnabled(
        this.config?.get<string>('PASSWORD_CHANGE_GATE') ??
          process.env.PASSWORD_CHANGE_GATE,
      )
    ) {
      return true;
    }
    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_DURING_PASSWORD_CHANGE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return true;
    throw new ForbiddenException({
      statusCode: 403,
      message: PASSWORD_CHANGE_REQUIRED_MESSAGE,
      code: PASSWORD_CHANGE_REQUIRED,
    });
  }
}
