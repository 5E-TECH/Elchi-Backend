import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { parseUzPhoneSearch, uzPhoneDigitsLikeSql } from '@app/common';
import { SearchDocument } from './entities/search-document.entity';

interface UpsertPayload {
  source: string;
  type: string;
  sourceId: string;
  title: string;
  content?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface RemovePayload {
  source: string;
  type: string;
  sourceId: string;
}

interface QueryPayload {
  q?: string;
  type?: string;
  source?: string;
  page?: number;
  limit?: number;
  // Set by the gateway from the JWT. Used to scope results so a low-privilege
  // account cannot harvest cross-tenant PII / order financials from the index.
  // ISeuwhfr: `market_id` — market operatorining biriktirilgan marketi
  // (gateway identity'dan oladi; boshqa rollar uchun e'tiborsiz).
  // hGcR8kio: `region_ids` — logistning o'z viloyatlari (gateway logistics'dan
  // oladi; faqat LOGIST uchun, boshqa rollar uchun e'tiborsiz).
  requester?: {
    id?: string;
    roles?: string[];
    market_id?: string | null;
    region_ids?: unknown;
  };
}

// Sources that contain user/staff PII (phones, usernames) — privileged-only.
const PII_SOURCES = ['identity', 'identity_fallback'];
const PRIVILEGED_SEARCH_ROLES = ['superadmin', 'admin'];
const MARKET_OPERATOR_ROLE = 'market_operator';
const BIGINT_ID_RE = /^[0-9]{1,19}$/;

/**
 * hGcR8kio — LOGIST qidiruvi (ega LG-S2/LG-S3): faqat o'z viloyatlari.
 * Shu rollardan biri bo'lsa o'sha rolning mavjud qoidasi ustun.
 */
const LOGIST_ROLE = 'logist';
const ROLES_WITH_OWN_SEARCH_SCOPE = [
  'superadmin',
  'admin',
  'manager',
  'branch',
  'registrator',
  'courier',
  'market',
  'market_operator',
  'customer',
];
/** Logistga ochiq geo hujjatlar — faqat nom (PII/pul yo'q). */
const LOGIST_GEO_TYPES = ['region', 'district'];

@Injectable()
export class SearchServiceService {
  constructor(
    @InjectRepository(SearchDocument)
    private readonly docs: Repository<SearchDocument>,
  ) {}

  async upsert(payload: UpsertPayload) {
    if (
      !payload.source ||
      !payload.type ||
      !payload.sourceId ||
      !payload.title
    ) {
      throw new RpcException({
        statusCode: 400,
        message: 'Invalid search upsert payload',
      });
    }

    let doc = await this.docs.findOne({
      where: {
        source: payload.source,
        type: payload.type,
        sourceId: payload.sourceId,
      },
    });

    if (!doc) {
      doc = this.docs.create({
        source: payload.source,
        type: payload.type,
        sourceId: payload.sourceId,
        title: payload.title,
        content: payload.content ?? null,
        tags: payload.tags ?? [],
        metadata: payload.metadata ?? null,
        isDeleted: false,
      });
    } else {
      doc.title = payload.title;
      doc.content = payload.content ?? null;
      doc.tags = payload.tags ?? [];
      doc.metadata = payload.metadata ?? null;
      doc.isDeleted = false;
    }

    const saved = await this.docs.save(doc);
    return { success: true, data: saved };
  }

  async remove(payload: RemovePayload) {
    const doc = await this.docs.findOne({
      where: {
        source: payload.source,
        type: payload.type,
        sourceId: payload.sourceId,
      },
    });

    if (!doc) {
      return { success: true, data: null };
    }

    doc.isDeleted = true;
    const saved = await this.docs.save(doc);
    return { success: true, data: saved };
  }

  async query(payload: QueryPayload) {
    const page = payload.page && payload.page > 0 ? payload.page : 1;
    const limit =
      payload.limit && payload.limit > 0 ? Math.min(payload.limit, 50) : 10;
    const skip = (page - 1) * limit;
    const q = payload.q?.trim();

    const roles = (payload.requester?.roles ?? []).map((r) =>
      String(r ?? '').toLowerCase(),
    );
    const requesterId = String(payload.requester?.id ?? '').trim();
    const isPrivileged = roles.some((r) => PRIVILEGED_SEARCH_ROLES.includes(r));

    const qb = this.docs
      .createQueryBuilder('doc')
      .where('doc.isDeleted = :isDeleted', { isDeleted: false });

    if (payload.type) {
      qb.andWhere('doc.type = :type', { type: payload.type });
    }

    if (payload.source) {
      qb.andWhere('doc.source = :source', { source: payload.source });
    }

    const isLogist =
      !isPrivileged &&
      roles.includes(LOGIST_ROLE) &&
      !roles.some((r) => ROLES_WITH_OWN_SEARCH_SCOPE.includes(r));

    if (isLogist) {
      // hGcR8kio: logist — o'z viloyatlari doirasidagi buyurtma, mijoz va
      // pochta; xodim PII'si yopiq (pastdagi umumiy band o'rniga).
      this.applyLogistScope(qb, payload.requester?.region_ids);
    } else if (!isPrivileged) {
      // Never expose user/staff PII (phones, usernames) to non-privileged roles.
      qb.andWhere('doc.source NOT IN (:...piiSources)', {
        piiSources: PII_SOURCES,
      });
      // Order documents are owner-scoped: a non-privileged caller sees an order
      // row only when its metadata market_id/courier_id/customer_id is theirs.
      // ISeuwhfr: market operatori — qo'shimcha ravishda biriktirilgan
      // marketining buyurtmalari (operatorning o'z id si hech qaysi
      // buyurtmaning market_id si emas — ilgari u umuman buyurtma topmasdi).
      // Market yo'q/noto'g'ri bo'lsa bu band qo'shilmaydi (fail-closed).
      const rawOperatorMarketId = String(
        payload.requester?.market_id ?? '',
      ).trim();
      const operatorMarketId =
        roles.includes(MARKET_OPERATOR_ROLE) &&
        BIGINT_ID_RE.test(rawOperatorMarketId)
          ? rawOperatorMarketId
          : '';
      const operatorArm = operatorMarketId
        ? ` OR doc.metadata->>'market_id' = :operatorMarketId`
        : '';
      qb.andWhere(
        `(doc.source <> :orderSource OR (
            :rid <> '' AND (
              doc.metadata->>'market_id' = :rid OR
              doc.metadata->>'courier_id' = :rid OR
              doc.metadata->>'customer_id' = :rid
            )
          )${operatorArm})`,
        {
          orderSource: 'order',
          rid: requesterId,
          ...(operatorMarketId ? { operatorMarketId } : {}),
        },
      );
    }

    if (q) {
      // zfPNDCCr: header global qidiruvi (GET /search?q=) telefonni
      // normallashtirmasdi — '+998330991009' mijoz '0330991009' yoki
      // '+998 33 099 10 09' bilan 0 natija berardi. Matn telefonga o'xshasa
      // milliy 9 raqam (qisman raqamda — kiritilgan raqamlar) bo'yicha ham
      // izlanadi: content ichida AYNAN (masalan buyurtma izohidagi raqam) va
      // `metadata.phone_number` ning FAQAT RAQAMLARI ichida — eski
      // (normallashtirilmagan) indeks yozuvlari ham topiladi, qayta
      // indekslash shart emas. Harfli matn ("Ali") — avvalgidek.
      const phone = parseUzPhoneSearch(q);
      const phoneSql = phone
        ? ` OR doc.content ILIKE :phoneDigits OR ${uzPhoneDigitsLikeSql(
            "doc.metadata->>'phone_number'",
          )}`
        : '';
      qb.andWhere(
        `(doc.title ILIKE :qLike OR doc.content ILIKE :qLike OR :qRaw = ANY(doc.tags)${phoneSql})`,
        {
          qLike: `%${q}%`,
          qRaw: q,
          ...(phone ? { phoneDigits: `%${phone.digits}%` } : {}),
        },
      );
    }

    const [rows, total] = await qb
      .orderBy('doc.updatedAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    // Strip content/metadata/tags for non-privileged callers — the projection
    // returns only enough to render a result and navigate to the entity.
    const items = isPrivileged
      ? rows
      : rows.map((r) => ({
          id: r.id,
          source: r.source,
          type: r.type,
          sourceId: r.sourceId,
          title: r.title,
        }));

    return {
      success: true,
      data: {
        items,
        meta: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      },
    };
  }

  /**
   * hGcR8kio — LOGIST doirasi (OQ RO'YXAT, qolgani yopiq):
   *  - buyurtma — `metadata.region_id` logist viloyatlaridan biri;
   *  - mijoz (`identity`, type `customer`) — o'z `region_id` si shu
   *    viloyatlarda YOKI shu viloyatlarda buyurtmasi bor (mijozlarda odatda
   *    faqat tuman bo'ladi — shuning uchun buyurtmalar orqali); xodim
   *    (kuryer/menejer/market...) identity hujjatlari — YO'Q;
   *  - pochta (`logistics`/`post`) — o'z viloyatlari;
   *  - viloyat/tuman nomlari — ochiq.
   * Katalog, filial va boshqa manbalar — yo'q. Viloyat biriktirilmagan
   * (yoki gateway uzata olmagan) logist — faqat viloyat/tuman nomlari.
   * Natija proyeksiyasi imtiyozsiz rollar bilan bir xil (id/title) —
   * telefon, summa (`total_price`) va boshqa metadata chiqmaydi.
   */
  private applyLogistScope(
    qb: SelectQueryBuilder<SearchDocument>,
    rawRegionIds: unknown,
  ): void {
    const regionIds = Array.from(
      new Set(
        (Array.isArray(rawRegionIds) ? (rawRegionIds as unknown[]) : [])
          .map((id) =>
            typeof id === 'string' || typeof id === 'number'
              ? String(id).trim()
              : '',
          )
          .filter((id) => BIGINT_ID_RE.test(id)),
      ),
    );
    const geoParams = {
      logistGeoSource: 'logistics',
      logistGeoTypes: LOGIST_GEO_TYPES,
    };
    if (!regionIds.length) {
      qb.andWhere(
        '(doc.source = :logistGeoSource AND doc.type IN (:...logistGeoTypes))',
        geoParams,
      );
      return;
    }

    // Mijozning shu viloyatlarda buyurtmasi bormi — o'sha jadvaldagi buyurtma
    // hujjatlari (ustun nomlari entity metadata'sidan, qo'shtirnoqli).
    const meta = this.docs.metadata as
      | {
          tablePath?: string;
          findColumnWithPropertyName?: (
            name: string,
          ) => { databaseName?: string } | undefined;
        }
      | undefined;
    const column = (property: string, fallback: string) =>
      `"${meta?.findColumnWithPropertyName?.(property)?.databaseName ?? fallback}"`;
    const table = (meta?.tablePath ?? 'search_documents')
      .split('.')
      .map((part) => `"${part}"`)
      .join('.');
    const customerHasOrderInRegions =
      `EXISTS (SELECT 1 FROM ${table} "logist_order" ` +
      `WHERE "logist_order".${column('source', 'source')} = :logistOrderSource ` +
      `AND "logist_order".${column('isDeleted', 'is_deleted')} = false ` +
      `AND "logist_order".${column('metadata', 'metadata')}->>'customer_id' = "doc".${column('sourceId', 'sourceId')} ` +
      `AND "logist_order".${column('metadata', 'metadata')}->>'region_id' IN (:...logistRegionIds))`;

    qb.andWhere(
      `((doc.source = :logistOrderSource AND doc.metadata->>'region_id' IN (:...logistRegionIds))` +
        ` OR (doc.source = :logistIdentitySource AND doc.type = :logistCustomerType AND (doc.metadata->>'region_id' IN (:...logistRegionIds) OR ${customerHasOrderInRegions}))` +
        ` OR (doc.source = :logistGeoSource AND doc.type = :logistPostType AND doc.metadata->>'region_id' IN (:...logistRegionIds))` +
        ` OR (doc.source = :logistGeoSource AND doc.type IN (:...logistGeoTypes)))`,
      {
        ...geoParams,
        logistOrderSource: 'order',
        logistIdentitySource: 'identity',
        logistCustomerType: 'customer',
        logistPostType: 'post',
        logistRegionIds: regionIds,
      },
    );
  }
}
