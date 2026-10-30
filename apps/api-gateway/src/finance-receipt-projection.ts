import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import {
  buildFileLinkUrl,
  FILE_LINK_TTL_SECONDS,
  type OriginRequest,
} from './file-link';

/**
 * T3 (QlLf33Ma) — kassa tarixidagi `receipt` bloklarini ROLGA qarab
 * proyeksiya qilish (javob daraxtining istalgan chuqurligida):
 *  - kuryer, market, registrator va boshqalar — `receipt` kaliti olib
 *    tashlanadi (chek va AI natijasi faqat SA/admin/menejerga);
 *  - to'liq ko'rinish (`file_key` bor) — kalit 300 s imzolangan havolaga
 *    almashtiriladi (FE'ga kalit chiqmaydi), `reanalyze_block` olib
 *    tashlanadi, `can_reanalyze` — faqat SA/admin;
 *  - menejer — faqat o'z filiali (`branch_id`) chekining to'liq
 *    ko'rinishi; boshqasi `null`.
 */
const MAX_DEPTH = 8;

export interface ReceiptViewer {
  roles: string[];
  branchId: string | null;
  req: OriginRequest;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export const canSeeReceipts = (roles: string[]) =>
  roles.some((role) =>
    [RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER].includes(
      role as RoleEnum,
    ),
  );

const isPrivileged = (roles: string[]) =>
  roles.includes(RoleEnum.SUPERADMIN) || roles.includes(RoleEnum.ADMIN);

/** To'liq chek ko'rinishi → FE shakli (`photo_url`, rolga mos `can_reanalyze`). */
export function projectFullReceipt(
  receipt: Record<string, unknown>,
  viewer: ReceiptViewer,
): Record<string, unknown> | null {
  if (!isPrivileged(viewer.roles)) {
    const raw = receipt.branch_id;
    const branch =
      typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
    if (!viewer.branchId || branch !== viewer.branchId) return null;
  }
  const rest: Record<string, unknown> = { ...receipt };
  const key = rest.file_key;
  const canReanalyze = rest.can_reanalyze;
  delete rest.file_key;
  delete rest.reanalyze_block;
  delete rest.can_reanalyze;
  const photoUrl = buildFileLinkUrl(viewer.req, key);
  return {
    ...rest,
    photo_url: photoUrl,
    photo_url_expires_in: photoUrl ? FILE_LINK_TTL_SECONDS : null,
    can_reanalyze: isPrivileged(viewer.roles) && canReanalyze === true,
  };
}

function walk(value: unknown, viewer: ReceiptViewer, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, viewer, depth + 1));
  }
  if (!isObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'receipt') {
      if (!canSeeReceipts(viewer.roles)) continue;
      out.receipt =
        isObject(item) && 'file_key' in item
          ? projectFullReceipt(item, viewer)
          : item;
      continue;
    }
    out[key] = item instanceof Date ? item : walk(item, viewer, depth + 1);
  }
  return out;
}

export function projectReceiptsForViewer<T>(
  payload: T,
  viewer: ReceiptViewer,
): T {
  return walk(payload, viewer, 0) as T;
}

/** Handler javobiga `projectReceiptsForViewer` (JWT'dagi rol va filial). */
@Injectable()
export class ReceiptProjectionInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<
      OriginRequest & {
        user?: { roles?: unknown; role?: unknown; branch_id?: unknown };
      }
    >();
    const roles = [
      ...(Array.isArray(req?.user?.roles) ? req.user.roles : []),
      req?.user?.role,
    ]
      .filter((role) => typeof role === 'string')
      .map((role) => String(role).trim().toLowerCase());
    const branchRaw = req?.user?.branch_id;
    const branchId =
      typeof branchRaw === 'string' || typeof branchRaw === 'number'
        ? String(branchRaw).trim() || null
        : null;
    return next
      .handle()
      .pipe(
        map((payload) =>
          projectReceiptsForViewer(payload, { roles, branchId, req }),
        ),
      );
  }
}
