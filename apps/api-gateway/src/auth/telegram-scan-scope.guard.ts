import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TELEGRAM_SCAN_SCOPE } from '@app/common';

export const ALLOW_TELEGRAM_SCAN_SCOPE_KEY = 'allowTelegramScanScope';

/**
 * (BOT-2 #2b) `scope: 'tg_scan'` (Telegram Mini App) tokeni bilan ochiq
 * route — faqat skan oqimi: `POST /orders/scan-assign`, `POST /telegram/scan/done`.
 */
export const AllowTelegramScanScope = () =>
  SetMetadata(ALLOW_TELEGRAM_SCAN_SCOPE_KEY, true);

export const TELEGRAM_SCAN_SCOPE_MESSAGE =
  'Telegram Mini App tokeni faqat skan uchun — kabinetdan kiring';

/**
 * (BOT-2 #2b) Global APP_GUARD — `JwtAuthGuard` dan KEYIN (`req.user`
 * tayyor). `tg_scan` scope'li token `@AllowTelegramScanScope()` siz har
 * qanday route'da 403. Scope'siz token (kabinet, bot aktori) — tegilmaydi.
 */
@Injectable()
export class TelegramScanScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context
      .switchToHttp()
      .getRequest<{ user?: { scope?: unknown } }>();
    if (request?.user?.scope !== TELEGRAM_SCAN_SCOPE) return true;
    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOW_TELEGRAM_SCAN_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return true;
    throw new ForbiddenException({
      statusCode: 403,
      message: TELEGRAM_SCAN_SCOPE_MESSAGE,
    });
  }
}
