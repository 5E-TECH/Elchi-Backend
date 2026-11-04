import type { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

/** identity `user.find_by_id` — gateway'dagi boshqa identity o'qishlari bilan bir xil 8 s. */
const MARKET_OPERATOR_PROFILE_TIMEOUT_MS = 8000;

/**
 * MARKET_OPERATOR biriktirilgan market — identity `user.market_id` (yagona
 * manba: so'rovdagi `market_id` ga ishonilmaydi). Buyurtma yaratish
 * (`OrderGatewayController`) va «Operator» tanlovi
 * (`GET /market-operators/selectable`) AYNI shu qiymat bilan ishlaydi.
 *
 * Topilmasa yoki identity javob bermasa — '' (chaqiruvchi rad etadi,
 * fail-closed).
 */
export async function resolveMarketOperatorMarketId(
  identityClient: Pick<ClientProxy, 'send'>,
  userId: unknown,
): Promise<string> {
  const profile: unknown = await firstValueFrom(
    identityClient
      .send({ cmd: 'identity.user.find_by_id' }, { id: userId })
      .pipe(timeout(MARKET_OPERATOR_PROFILE_TIMEOUT_MS)),
  ).catch(() => null);
  const raw = (profile as { data?: { market_id?: unknown } } | null)?.data
    ?.market_id;
  return typeof raw === 'string' || typeof raw === 'number'
    ? String(raw).trim()
    : '';
}
