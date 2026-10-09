import type {
  CreateMarketOperatorDto,
  UpdateMarketOperatorCommissionDto,
} from '../dto/market-operator.dto';
import type { RequesterContext } from './user.payloads';

/**
 * identity.market_operator.* (i76gGjyq). `market_id` HAR DOIM gateway
 * tomonidan qo'yiladi: market so'rovida — JWT `sub`, superadmin/admin
 * ko'rishida — `?market_id=`. Servis uni requester bilan qayta solishtiradi
 * (market faqat o'z id'si bilan).
 */
export interface CreateMarketOperatorPayload {
  market_id: string;
  dto: CreateMarketOperatorDto;
  requester?: RequesterContext;
}

export interface MarketOperatorFilterQuery {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export interface FindMarketOperatorsPayload {
  market_id: string;
  query?: MarketOperatorFilterQuery;
  requester?: RequesterContext;
}

export interface DeleteMarketOperatorPayload {
  id: string;
  market_id: string;
  requester?: RequesterContext;
}

export interface UpdateMarketOperatorCommissionPayload {
  id: string;
  market_id: string;
  dto: UpdateMarketOperatorCommissionDto;
  requester?: RequesterContext;
}
