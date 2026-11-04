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

/**
 * identity.market_operator.selectable — buyurtma yaratish formasidagi
 * «Operator» tanlovi. Qaysi market — gateway rol bo'yicha hal qiladi
 * (`GET /market-operators/selectable`), shu sabab requester yo'q.
 * `operator_id` — `POST /orders` da tanlangan operatorni ro'yxat bilan AYNI
 * qoida bo'yicha tekshirish uchun (faqat o'sha qator qaytadi).
 */
export interface SelectableMarketOperatorsPayload {
  market_id: string;
  operator_id?: string;
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

/** identity.market_operator.update_warehouse_access (XtcEyQjb). */
export interface UpdateMarketOperatorWarehouseAccessPayload {
  id: string;
  market_id: string;
  dto: { can_view_warehouse_stock?: unknown };
  requester?: RequesterContext;
}

/** identity.market_operator.set_status (mFkrqvMi). */
export interface SetMarketOperatorStatusPayload {
  id: string;
  market_id: string;
  dto: { status?: unknown };
  requester?: RequesterContext;
}
