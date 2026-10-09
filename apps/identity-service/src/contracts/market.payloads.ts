import { CreateMarketDto } from '../dto/create-market.dto';
import { UpdateMarketDto } from '../dto/update-market.dto';
import { RequesterContext, UserFilterQuery } from './user.payloads';

export interface CreateMarketPayload {
  dto: CreateMarketDto;
  requester?: RequesterContext;
}

export interface UpdateMarketPayload {
  id: string;
  dto: UpdateMarketDto;
  requester?: RequesterContext;
}

export interface DeleteMarketPayload {
  id: string;
}

export interface FindMarketByIdPayload {
  id: string;
}

export interface FindMarketsByIdsPayload {
  ids: string[];
}

export interface FindAllMarketsPayload {
  query?: UserFilterQuery;
}

export interface FindMarketByTgTokenPayload {
  market_tg_token: string;
}

/**
 * (GvL6ZFAd) market_tg_token'ni ko'rish/almashtirish RPC'lari. Faqat
 * SUPERADMIN: gateway (RolesGuard) va identity (requester.roles) ikkalasi
 * tekshiradi — requester'siz yoki boshqa rol bilan 403.
 */
export interface GetMarketTgTokenPayload {
  id: string;
  requester?: RequesterContext;
}

export interface RotateMarketTgTokenPayload {
  id: string;
  requester?: RequesterContext;
}

/**
 * Barcha faol (is_deleted = false) marketlar tokenini bitta tranzaksiyada
 * almashtirish uchun aniq tasdiq. Gateway DTO
 * (RotateAllMarketTgTokensRequestDto) ham AYNAN shu qiymatni kutadi.
 */
export const MARKET_TG_TOKEN_ROTATE_ALL_CONFIRM = 'ROTATE_ALL';

export interface RotateAllMarketTgTokensPayload {
  confirm?: unknown;
  requester?: RequesterContext;
}
