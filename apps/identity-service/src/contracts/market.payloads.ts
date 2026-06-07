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

export interface RotateMarketTgTokenPayload {
  id: string;
}
