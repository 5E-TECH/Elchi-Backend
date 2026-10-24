import { CreateAdminDto } from '../dto/create-admin.dto';
import { CreateCourierDto } from '../dto/create-courier.dto';
import { CreateCustomerDto } from '../dto/create-customer.dto';
import { CreateManagerDto } from '../dto/create-manager.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { Status } from '@app/common';

export interface RequesterContext {
  id: string;
  roles: string[];
  allowed_user_ids?: string[];
}

export interface CreateUserPayload {
  dto: CreateAdminDto;
  requester?: RequesterContext;
}

export interface CreateCourierPayload {
  dto: CreateCourierDto;
  requester?: RequesterContext;
}

export interface CreateCustomerPayload {
  dto: CreateCustomerDto;
}

export interface CreateManagerPayload {
  dto: CreateManagerDto;
  requester?: RequesterContext;
}

/**
 * o2j9uDtT — viloyatlar bo'yicha kuryerlar soni (GET /region/stats/all
 * xarita tooltipi). `region_ids` — logistics viloyat ID'lari.
 */
export interface CourierRegionCountsPayload {
  region_ids?: Array<string | number>;
}

export interface FindCouriersByIdsPayload {
  ids: string[];
  /** hEjjuJaT: buyurtma viloyati — super-kuryerning viloyat tarifi uchun. */
  region_id?: string | null;
}

export interface UpdateUserPayload {
  id: string;
  dto: UpdateUserDto;
  requester?: RequesterContext;
  /**
   * (Elchi Pochta #3, 2026-10-23) So'rov yuborgan sessiya — gateway JWT
   * `sid` i (`PATCH /auth/my-profile`, `PATCH /users/:id`). Parolni o'zi
   * almashtirsa shu sessiya qoladi, qolganlari darhol yopiladi.
   */
  current_session_id?: string | null;
}

export interface DeleteUserPayload {
  id: string;
  requester?: RequesterContext;
}

export interface FindUserByIdPayload {
  id: string;
  /** (i76gGjyq) Faqat ichki: o'chirilgan foydalanuvchini ham qaytarish. */
  include_deleted?: boolean;
  /**
   * YEThmZBn — GET /users/:id: kuryer/menejer/registrator filiali
   * (`branch: { id, name } | null`) ham qaytsin. Faqat gateway yuboradi.
   */
  include_branch?: boolean;
  // (GvL6ZFAd) `include_tg_token` olib tashlandi: kelsa ham e'tiborsiz —
  // market_tg_token faqat identity.market.get_tg_token (SUPERADMIN) orqali.
}

export interface UserFilterQuery {
  search?: string;
  role?: string;
  status?: string;
  region_id?: string;
  user_ids?: string[];
  /**
   * 2CBnPAeg — menejer ko'lami (faqat `identity.user.find_all`, GET /users):
   * kuryer va filial rolidagi foydalanuvchi faqat `user_ids` ichida bo'lsa
   * chiqadi (menejer filialiga biriktirilganlar); boshqa rollar cheklanmaydi.
   * Ro'yxat ham, `total` / `countsByRole` ham shu shart bilan sanaladi.
   */
  branch_scope?: { user_ids?: string[] } | null;
  /**
   * yA31z7Rr — GET /users «Ulangan / Ulanmagan»: true — `telegram_id` bor,
   * false — yo'q (javobdagi `telegram_linked` bilan bir xil qoida).
   */
  telegram_linked?: boolean | string | null;
  page?: number;
  limit?: number;
}

export interface FindAllUsersPayload {
  query?: UserFilterQuery;
}

/** K3scaE0W — identity.user.change_role (PATCH /users/:id/role). */
export interface ChangeUserRolePayload {
  id: string;
  role: string;
  requester?: RequesterContext;
}

export interface UpdateUserStatusPayload {
  id: string;
  status: Status;
  requester?: RequesterContext;
}

/**
 * identity.courier.set_region (ichki; chaqiruvchi — branch-service kuryer
 * o'tkazish). region_id: faqat raqamlar yoki null (HQ'ning hududi bo'sh
 * bo'lishi mumkin).
 */
export interface SetCourierRegionPayload {
  id: string;
  region_id?: string | null;
  requester?: RequesterContext;
  /**
   * Epoch ms. Branch-service o'tkazishdagi set_region'ga yuboradi (yuborish
   * vaqti + uning timeout'i): shundan keyin — qator qulfi olingach — hudud
   * YOZILMAYDI (409), chunki chaqiruvchi vaqt tugaganini ko'rib o'tkazishni
   * allaqachon qaytargan. Tiklash va qayta moslash uni yubormaydi.
   */
  deadline_at?: number;
}
