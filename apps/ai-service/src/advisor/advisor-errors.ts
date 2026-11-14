import { HttpException, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  Roles,
  type AiAdvisorErrorCode,
  type AiAdvisorRequester,
} from '@app/common';
import { errorRes } from '../../../../libs/common/helpers/response';

type PublicField = string | number | boolean | null;

/**
 * Kodli xato: gateway `AllExceptionsFilter` `code` va shu kodga ruxsat
 * etilgan maydonlarni (`PUBLIC_ERROR_CODES`) javobga chiqaradi.
 *
 * ⚠️ `AiServiceController.adminCall` HttpException'ni `errorRes(message,
 * status)` ga o'raydi va `code` ni KESADI — advisor handler'lari shuning
 * uchun `advisorCall` dan foydalanadi.
 */
export function advisorError(
  statusCode: number,
  code: AiAdvisorErrorCode,
  message: string,
  fields: Record<string, PublicField> = {},
): RpcException {
  return new RpcException({
    statusCode,
    message,
    data: null,
    code,
    ...fields,
  });
}

/** Faqat superadmin (ega qarori 1); gateway `RolesGuard` ning ikkinchi qavati. */
export function assertSuperadmin(
  requester: AiAdvisorRequester | null | undefined,
): AiAdvisorRequester {
  const roles = Array.isArray(requester?.roles) ? requester.roles : [];
  const id = requester?.id == null ? '' : String(requester.id);
  if (
    !requester ||
    !/^\d{1,18}$/.test(id) ||
    !roles.includes(Roles.SUPERADMIN)
  ) {
    throw new RpcException(errorRes("Bu amal uchun ruxsat yo'q", 403));
  }
  return { id, roles, name: requester.name ?? null };
}

const logger = new Logger('AiAdvisor');

/**
 * Handler o'rami: `RpcException` o'zgarishsiz; HttpException — status bilan;
 * kutilmagan xato — 500 (payload logga chiqmaydi).
 */
export async function advisorCall<T>(
  cmd: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RpcException) throw err;
    if (err instanceof HttpException) {
      throw new RpcException(errorRes(err.message, err.getStatus()));
    }
    const name = err instanceof Error ? err.constructor?.name || err.name : '';
    const msg = err instanceof Error ? err.message : 'non-error throw';
    logger.error(`ai_advisor_failed cmd=${cmd}: ${name}: ${msg}`.slice(0, 400));
    throw new RpcException(errorRes(`${cmd} bajarilmadi`, 500));
  }
}
