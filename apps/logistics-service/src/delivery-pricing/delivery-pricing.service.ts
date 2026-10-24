import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import {
  ActivityDescribeUz,
  ActivityLogService,
  computeDeliveryQuote,
  DELIVERY_TARIFF_IDS,
  DELIVERY_WHERE_DELIVER_IDS,
  DeliveryPricingInputError,
  DeliveryPricingItem,
  DeliveryQuote,
  resolveDeliveryTariffId,
  rmqSend,
  Roles,
} from '@app/common';
import { errorRes, successRes } from '../../../../libs/common/helpers/response';
import { DeliveryTariff } from '../entities/delivery-tariff.entity';
import { DeliveryPricingSettings } from '../entities/delivery-pricing-settings.entity';
import { Region } from '../entities/region.entity';
import { District } from '../entities/district.entity';
import {
  DELIVERY_PRICING_SETTINGS_FIELDS,
  DELIVERY_QUOTE_MAX_ITEMS,
  type CreateDeliveryTariffPayload,
  type DeliveryPricingRequester,
  type DeliveryQuoteItemPayload,
  type DeliveryQuotePayload,
  type DeliveryQuoteByTariffPayload,
  type DeliveryPricingSettingsField,
  type ListDeliveryTariffsPayload,
  type UpdateDeliveryPricingSettingsPayload,
} from './delivery-pricing.types';

/** Catalog'dan o'lchov o'qish — gateway 8 s ichida javob olishi uchun qisqa. */
const CATALOG_LOOKUP_OPTIONS = Object.freeze({
  timeoutMs: 3000,
  retries: 1,
  deadlineMs: 6000,
  attachRequestId: false,
});

/** `pg_advisory_xact_lock` kaliti — sozlama yangilash ketma-ketligi. */
const SETTINGS_UPDATE_LOCK_KEY = 1716000000142;

/** Tarif tarixi sahifasi (GET /delivery/tariffs). */
const TARIFF_HISTORY_DEFAULT_LIMIT = 100;
const TARIFF_HISTORY_MAX_LIMIT = 500;

/**
 * Orqaga sanalgan tarif TAQIQ: berilgan narxlar va (KmWO9gTA dan keyin)
 * sotuvdagi snapshot'lar o'tmishdagi tarifga tayanadi. Soat farqi uchun
 * kichik tolerantlik.
 */
const VALID_FROM_PAST_TOLERANCE_MS = 5 * 60 * 1000;

interface CatalogProductRow {
  id: string;
  user_id?: string | null;
  weight_kg?: number | string | null;
  length_cm?: number | string | null;
  width_cm?: number | string | null;
  height_cm?: number | string | null;
  volumetric_enabled?: boolean | null;
}

interface ResolvedQuoteItem extends DeliveryPricingItem {
  product_id: string | null;
}

const isPositiveInt = (n: unknown): boolean =>
  typeof n === 'number' && Number.isInteger(n) && n > 0;

/**
 * DAqXPeSy — yetkazish narxi: DB o'qish va admin yozuvlari shu yerda, HISOB
 * esa `@app/common` `computeDeliveryQuote` da (sof funksiya).
 *
 * KESH YO'Q: har so'rov faol tarif va sozlamani DB'dan o'qiydi — admin
 * o'zgartirsa keyingi hisob darhol yangi qiymat bilan chiqadi.
 */
@Injectable()
export class DeliveryPricingService {
  constructor(
    @InjectRepository(DeliveryTariff)
    private readonly tariffRepo: Repository<DeliveryTariff>,
    @InjectRepository(DeliveryPricingSettings)
    private readonly settingsRepo: Repository<DeliveryPricingSettings>,
    @InjectRepository(Region) private readonly regionRepo: Repository<Region>,
    @InjectRepository(District)
    private readonly districtRepo: Repository<District>,
    @Inject('CATALOG') private readonly catalogClient: ClientProxy,
    private readonly activityLog: ActivityLogService,
  ) {}

  // ---------------------------------------------------------------- xatolar

  private fail(message: string, code: number, data?: unknown): never {
    throw new RpcException(errorRes(message, code, data));
  }

  private auditActor(requester?: DeliveryPricingRequester | null) {
    const roles = requester?.roles ?? [];
    return {
      user_id: requester?.id ? String(requester.id) : null,
      user_role: roles.length ? roles.join(',') : null,
    };
  }

  // ------------------------------------------------------------- o'qishlar

  /** Faol tarif versiyasi: `valid_from <= now()` (DB soati), eng so'nggisi. */
  async findCurrentTariff(
    tariffId: string,
    manager: EntityManager = this.tariffRepo.manager,
  ): Promise<DeliveryTariff | null> {
    return manager
      .getRepository(DeliveryTariff)
      .createQueryBuilder('t')
      .where('t.tariff_id = :tariffId', { tariffId })
      .andWhere('t.is_active = true')
      .andWhere('t.isDeleted = false')
      .andWhere('t.valid_from <= now()')
      .orderBy('t.valid_from', 'DESC')
      .addOrderBy('t.id', 'DESC')
      .limit(1)
      .getOne();
  }

  async findActiveSettings(
    manager: EntityManager = this.settingsRepo.manager,
  ): Promise<DeliveryPricingSettings | null> {
    return manager.getRepository(DeliveryPricingSettings).findOne({
      where: { is_active: true, isDeleted: false },
      order: { id: 'DESC' },
    });
  }

  private async requireActiveSettings(): Promise<DeliveryPricingSettings> {
    const settings = await this.findActiveSettings();
    if (!settings) {
      this.fail(
        'Yetkazish narxi sozlamalari topilmadi (migratsiya 1716000000142 yurgizilmagan?)',
        409,
      );
    }
    return settings;
  }

  /**
   * `GET /delivery/tariffs`: har tarifning HOZIRGI versiyasi + versiyalar
   * tarixi (kelajakdagi rejalashtirilganlari ham), yangisi tepada.
   */
  async listTariffs(payload: ListDeliveryTariffsPayload = {}) {
    const tariffFilter = payload.tariff_id
      ? this.requireTariffId(payload.tariff_id)
      : null;
    const rawLimit = Number(payload.limit);
    const limit =
      Number.isInteger(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, TARIFF_HISTORY_MAX_LIMIT)
        : TARIFF_HISTORY_DEFAULT_LIMIT;

    const current: Record<string, DeliveryTariff | null> = {};
    for (const id of DELIVERY_TARIFF_IDS) {
      current[id] = await this.findCurrentTariff(id);
    }

    const qb = this.tariffRepo
      .createQueryBuilder('t')
      .where('t.isDeleted = false')
      .orderBy('t.valid_from', 'DESC')
      .addOrderBy('t.id', 'DESC')
      .take(limit);
    if (tariffFilter)
      qb.andWhere('t.tariff_id = :tariffFilter', { tariffFilter });
    const versions = await qb.getMany();

    const currentIds = new Set(
      Object.values(current)
        .filter((row): row is DeliveryTariff => !!row)
        .map((row) => String(row.id)),
    );
    const now = Date.now();
    return successRes({
      current,
      versions: versions.map((row) => ({
        ...row,
        is_current: currentIds.has(String(row.id)),
        is_scheduled: row.is_active && new Date(row.valid_from).getTime() > now,
      })),
    });
  }

  async getSettings() {
    return successRes(await this.requireActiveSettings());
  }

  // ------------------------------------------------------------ hisoblash

  /**
   * `logistics.delivery.quote` — FAQAT hisoblaydi, hech narsa yozmaydi.
   *
   * Tarif tanlash: yo'nalishning ikkala uchi ham `regions.is_city_zone` →
   * `city`, aks holda `where_deliver`. Tuman berilsa uning GEOGRAFIK viloyati
   * (`districts.region_id`) olinadi — `assigned_region` (qaysi filial
   * xizmat qiladi) narxga ta'sir qilmaydi: Toshkent viloyati tumani shahar
   * filialiga biriktirilgan bo'lsa ham "boshqa viloyat" (landing qarori).
   *
   * `items[]` — har biri yo `product_id` (o'lchov catalog'dan), yo to'g'ridan
   * o'lchov. MARKET faqat o'z mahsulotlarini hisoblay oladi (begonasi — 404,
   * mavjudligi oshkor qilinmaydi).
   */
  /**
   * `logistics.delivery.quote_by_tariff` — FAQAT hisoblaydi. Hudud yo'q:
   * bir xil elementlar uchun har faol tarif (city / center / address) bo'yicha
   * alohida natija. Elementlar `quote` dagi kabi (product_id yoki o'lchov;
   * MARKET — faqat o'z mahsuloti). Faol versiyasi yo'q tarif natijada `null`.
   */
  async quoteByTariff(payload: DeliveryQuoteByTariffPayload) {
    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    if (!rawItems.length) {
      this.fail("items — kamida bitta element bo'lishi kerak", 400);
    }
    if (rawItems.length > DELIVERY_QUOTE_MAX_ITEMS) {
      this.fail(
        `items — ko'pi bilan ${DELIVERY_QUOTE_MAX_ITEMS} ta element`,
        400,
      );
    }
    const [settings, items, ...tariffs] = await Promise.all([
      this.requireActiveSettings(),
      this.resolveQuoteItems(rawItems, payload.requester),
      ...DELIVERY_TARIFF_IDS.map((id) => this.findCurrentTariff(id)),
    ]);
    const quotes: Record<string, unknown> = {};
    DELIVERY_TARIFF_IDS.forEach((id, index) => {
      const tariff = tariffs[index];
      if (!tariff) {
        quotes[id] = null;
        return;
      }
      let result: DeliveryQuote;
      try {
        result = computeDeliveryQuote({
          items,
          tariff,
          settings,
          express: payload.express === true,
          pickupCount: 0,
        });
      } catch (error) {
        if (error instanceof DeliveryPricingInputError) {
          this.fail(error.message, 400);
        }
        throw error;
      }
      quotes[id] = {
        ...result,
        tariff: {
          id: String(tariff.id),
          tariff_id: tariff.tariff_id,
          base_price: tariff.base_price,
          extra_per_kg: tariff.extra_per_kg,
          days_min: tariff.days_min,
          days_max: tariff.days_max,
          valid_from: tariff.valid_from,
        },
      };
    });
    return successRes({
      quotes,
      settings_id: String(settings.id),
      unmeasured_product_ids: items
        .filter(
          (item) =>
            item.product_id &&
            (item.weight_kg === null || item.weight_kg === undefined),
        )
        .map((item) => item.product_id as string),
    });
  }

  async quote(payload: DeliveryQuotePayload) {
    const whereDeliver = String(payload?.where_deliver ?? '');
    if (
      !(DELIVERY_WHERE_DELIVER_IDS as readonly string[]).includes(whereDeliver)
    ) {
      this.fail("where_deliver — 'center' yoki 'address' bo'lishi kerak", 400);
    }
    const rawItems = Array.isArray(payload?.items) ? payload.items : [];
    if (!rawItems.length) {
      this.fail("items — kamida bitta element bo'lishi kerak", 400);
    }
    if (rawItems.length > DELIVERY_QUOTE_MAX_ITEMS) {
      this.fail(
        `items — ko'pi bilan ${DELIVERY_QUOTE_MAX_ITEMS} ta element`,
        400,
      );
    }

    const [from, to] = await Promise.all([
      this.resolveRouteRegion(
        'from',
        payload.from_region_id,
        payload.from_district_id,
      ),
      this.resolveRouteRegion(
        'to',
        payload.to_region_id,
        payload.to_district_id,
      ),
    ]);

    const tariffId = resolveDeliveryTariffId({
      fromCityZone: !!from.is_city_zone,
      toCityZone: !!to.is_city_zone,
      whereDeliver,
    });

    const [tariff, settings, items] = await Promise.all([
      this.findCurrentTariff(tariffId),
      this.requireActiveSettings(),
      this.resolveQuoteItems(rawItems, payload.requester),
    ]);
    if (!tariff) {
      this.fail(`Faol yetkazish tarifi topilmadi: ${tariffId}`, 409);
    }

    let result: DeliveryQuote;
    try {
      result = computeDeliveryQuote({
        items,
        tariff,
        settings,
        express: payload.express === true,
        pickupCount: payload.pickup_count ?? 0,
      });
    } catch (error) {
      if (error instanceof DeliveryPricingInputError) {
        this.fail(error.message, 400);
      }
      throw error;
    }

    const productIdsWhere = (match: (item: ResolvedQuoteItem) => boolean) =>
      items
        .filter((item) => item.product_id && match(item))
        .map((item) => item.product_id as string);

    return successRes({
      ...result,
      route: {
        from_region_id: String(from.id),
        to_region_id: String(to.id),
        city_route: tariffId === 'city',
        where_deliver: whereDeliver,
      },
      tariff: {
        id: String(tariff.id),
        tariff_id: tariff.tariff_id,
        base_price: tariff.base_price,
        extra_per_kg: tariff.extra_per_kg,
        days_min: tariff.days_min,
        days_max: tariff.days_max,
        valid_from: tariff.valid_from,
      },
      settings_id: String(settings.id),
      unmeasured_product_ids: productIdsWhere(
        (item) => item.weight_kg === null || item.weight_kg === undefined,
      ),
      missing_dimension_product_ids: productIdsWhere(
        (item) =>
          item.volumetric_enabled !== false &&
          [item.length_cm, item.width_cm, item.height_cm].some(
            (d) => d === null || d === undefined,
          ),
      ),
    });
  }

  private async resolveRouteRegion(
    side: 'from' | 'to',
    regionId?: string | number | null,
    districtId?: string | number | null,
  ): Promise<Region> {
    const regionKey = regionId == null ? '' : String(regionId).trim();
    const districtKey = districtId == null ? '' : String(districtId).trim();
    if (!regionKey && !districtKey) {
      this.fail(`${side}_region_id yoki ${side}_district_id majburiy`, 400);
    }
    for (const [field, value] of [
      [`${side}_region_id`, regionKey],
      [`${side}_district_id`, districtKey],
    ] as const) {
      if (value && !/^\d{1,18}$/.test(value)) {
        this.fail(`${field} — raqamli id bo'lishi kerak`, 400);
      }
    }

    let geoRegionId = regionKey;
    if (districtKey) {
      const district = await this.districtRepo.findOne({
        where: { id: districtKey },
      });
      if (!district) this.fail(`Tuman topilmadi (${side}_district_id)`, 404);
      if (regionKey && String(district.region_id) !== regionKey) {
        this.fail(
          `${side}_district_id ${side}_region_id viloyatiga tegishli emas`,
          400,
        );
      }
      geoRegionId = String(district.region_id);
    }

    const region = await this.regionRepo.findOne({
      where: { id: geoRegionId },
    });
    if (!region) this.fail(`Viloyat topilmadi (${side}_region_id)`, 404);
    return region;
  }

  private async resolveQuoteItems(
    rawItems: DeliveryQuoteItemPayload[],
    requester?: DeliveryPricingRequester,
  ): Promise<ResolvedQuoteItem[]> {
    const productIds = new Set<string>();
    rawItems.forEach((raw, index) => {
      const productId =
        raw?.product_id == null ? '' : String(raw.product_id).trim();
      if (!productId) return;
      if (!/^\d{1,18}$/.test(productId)) {
        this.fail(
          `items[${index}].product_id — raqamli id bo'lishi kerak`,
          400,
        );
      }
      const hasMeasure = (
        [
          'weight_kg',
          'length_cm',
          'width_cm',
          'height_cm',
          'volumetric_enabled',
        ] as const
      ).some((key) => raw[key] !== undefined && raw[key] !== null);
      if (hasMeasure) {
        this.fail(
          `items[${index}] — product_id bilan o'lchov yuborilmaydi (o'lchov catalog'dan olinadi)`,
          400,
        );
      }
      productIds.add(productId);
    });

    const products = productIds.size
      ? await this.loadProducts([...productIds])
      : new Map<string, CatalogProductRow>();

    const isMarket = (requester?.roles ?? []).some(
      (role) => String(role).toLowerCase() === String(Roles.MARKET),
    );
    const missing = [...productIds].filter((id) => {
      const product = products.get(id);
      if (!product) return true;
      return (
        isMarket && String(product.user_id ?? '') !== String(requester?.id)
      );
    });
    if (missing.length) {
      this.fail(`Mahsulot topilmadi: ${missing.join(', ')}`, 404, {
        product_ids: missing,
      });
    }

    return rawItems.map((raw) => {
      const productId =
        raw?.product_id == null ? '' : String(raw.product_id).trim();
      const quantity = raw?.quantity ?? 1;
      if (productId) {
        const product = products.get(productId) as CatalogProductRow;
        return {
          product_id: productId,
          weight_kg: product.weight_kg ?? null,
          length_cm: product.length_cm ?? null,
          width_cm: product.width_cm ?? null,
          height_cm: product.height_cm ?? null,
          volumetric_enabled: product.volumetric_enabled !== false,
          quantity,
        };
      }
      return {
        product_id: null,
        weight_kg: raw?.weight_kg ?? null,
        length_cm: raw?.length_cm ?? null,
        width_cm: raw?.width_cm ?? null,
        height_cm: raw?.height_cm ?? null,
        volumetric_enabled: raw?.volumetric_enabled !== false,
        quantity,
      };
    });
  }

  private async loadProducts(
    ids: string[],
  ): Promise<Map<string, CatalogProductRow>> {
    let response: { data?: CatalogProductRow[] } | undefined;
    try {
      response = await rmqSend<{ data?: CatalogProductRow[] }>(
        this.catalogClient,
        { cmd: 'catalog.product.find_by_ids' },
        { ids },
        CATALOG_LOOKUP_OPTIONS,
      );
    } catch {
      this.fail(
        "Mahsulot o'lchovlarini o'qib bo'lmadi (catalog-service javob bermadi)",
        503,
      );
    }
    const rows = Array.isArray(response?.data) ? response.data : [];
    return new Map(rows.map((row) => [String(row.id), row]));
  }

  // ------------------------------------------------------- admin yozuvlari

  private requireTariffId(value: unknown): string {
    const tariffId = typeof value === 'string' ? value.trim() : '';
    if (!(DELIVERY_TARIFF_IDS as readonly string[]).includes(tariffId)) {
      this.fail("tariff_id — 'city', 'center' yoki 'address'", 400);
    }
    return tariffId;
  }

  private requireMoney(value: unknown, field: string): number {
    const n = typeof value === 'string' ? Number(value) : value;
    if (
      typeof n !== 'number' ||
      !Number.isFinite(n) ||
      n < 0 ||
      n > 999_999_999_999.99 ||
      Math.round(n * 100) / 100 !== n
    ) {
      this.fail(`${field} — 0 yoki musbat, ko'pi bilan 2 kasrli son`, 400);
    }
    return n;
  }

  private requireDays(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      this.fail(`${field} — manfiy bo'lmagan butun son`, 400);
    }
    return value;
  }

  /**
   * `POST /delivery/tariffs` — YANGI versiya. Eski qatorlar o'chirilmaydi va
   * o'zgartirilmaydi; `valid_from` berilmasa — hozir, kelajak sana —
   * rejalashtirilgan versiya, o'tmish sana — 400.
   */
  async createTariff(
    payload: CreateDeliveryTariffPayload,
    requester?: DeliveryPricingRequester,
  ) {
    const tariffId = this.requireTariffId(payload?.tariff_id);
    const basePrice = this.requireMoney(payload?.base_price, 'base_price');
    const extraPerKg = this.requireMoney(payload?.extra_per_kg, 'extra_per_kg');
    const daysMin = this.requireDays(payload?.days_min, 'days_min');
    const daysMax = this.requireDays(payload?.days_max, 'days_max');
    if (daysMax < daysMin) {
      this.fail("days_max days_min dan kichik bo'lmasligi kerak", 400);
    }

    let validFrom: Date | null = null;
    if (payload?.valid_from !== undefined && payload?.valid_from !== null) {
      validFrom = new Date(payload.valid_from);
      if (Number.isNaN(validFrom.getTime())) {
        this.fail('valid_from — ISO sana-vaqt bo`lishi kerak', 400);
      }
      if (validFrom.getTime() < Date.now() - VALID_FROM_PAST_TOLERANCE_MS) {
        this.fail(
          "valid_from o'tmishda bo'lmasligi kerak (tarif orqaga sanalmaydi)",
          400,
        );
      }
    }

    const previous = await this.findCurrentTariff(tariffId);
    const created = await this.tariffRepo.save(
      this.tariffRepo.create({
        tariff_id: tariffId,
        base_price: basePrice,
        extra_per_kg: extraPerKg,
        days_min: daysMin,
        days_max: daysMax,
        ...(validFrom ? { valid_from: validFrom } : {}),
        is_active: true,
        created_by: requester?.id ? String(requester.id) : null,
      }),
    );
    // `valid_from` DB'da `now()` bilan to'lgan bo'lsa — haqiqiy qiymatni o'qish.
    const saved =
      (await this.tariffRepo.findOne({ where: { id: created.id } })) ?? created;

    await this.activityLog.log({
      entity_type: 'DeliveryTariff',
      entity_id: String(saved.id),
      action: 'logistics.delivery_tariff_created',
      old_value: previous
        ? {
            id: String(previous.id),
            tariff_id: previous.tariff_id,
            base_price: previous.base_price,
            extra_per_kg: previous.extra_per_kg,
            days_min: previous.days_min,
            days_max: previous.days_max,
            valid_from: previous.valid_from,
          }
        : null,
      new_value: {
        id: String(saved.id),
        tariff_id: saved.tariff_id,
        base_price: saved.base_price,
        extra_per_kg: saved.extra_per_kg,
        days_min: saved.days_min,
        days_max: saved.days_max,
        valid_from: saved.valid_from,
      },
      description: ActivityDescribeUz.deliveryTariffVersionCreated(
        saved.tariff_id,
        saved.base_price,
        saved.extra_per_kg,
      ),
      ...this.auditActor(requester),
    });

    return successRes(
      saved,
      201,
      'Yetkazish tarifining yangi versiyasi yaratildi',
    );
  }

  /**
   * `PATCH /delivery/pricing-settings` — qisman o'zgartirish YANGI faol qator
   * sifatida yoziladi (eskisi `is_active = false`), bitta tranzaksiyada va
   * faol qator qulfi bilan (ikki admin bir vaqtda — ketma-ket). Hech narsa
   * o'zgarmasa — yangi versiya ham, jurnal ham yo'q.
   */
  async updateSettings(
    payload: UpdateDeliveryPricingSettingsPayload,
    requester?: DeliveryPricingRequester,
  ) {
    const patch = this.validateSettingsPatch(payload ?? {});
    if (!Object.keys(patch).length) {
      this.fail("O'zgartirish uchun kamida bitta maydon yuboring", 400);
    }

    const outcome = await this.settingsRepo.manager.transaction(async (em) => {
      // Tranzaksiya darajasidagi advisory qulf: ikki admin bir vaqtda
      // o'zgartirsa ikkinchisi birinchisi COMMIT bo'lgach YANGI faol qatorni
      // o'qiydi. (`FOR UPDATE` yetmaydi: READ COMMITTED'da kutgan so'rov
      // `is_active=false` bo'lib qolgan eski qatorni tashlab, yangisini
      // ko'rmaydi va soxta 409 qaytaradi.)
      await em.query('SELECT pg_advisory_xact_lock($1)', [
        SETTINGS_UPDATE_LOCK_KEY,
      ]);
      const repo = em.getRepository(DeliveryPricingSettings);
      const active = await repo.findOne({
        where: { is_active: true, isDeleted: false },
        order: { id: 'DESC' },
      });
      if (!active) {
        this.fail('Faol yetkazish narxi sozlamasi topilmadi', 409);
      }

      const before = this.settingsValues(active);
      const after = { ...before, ...patch };
      this.assertSettingsConsistent(after);
      const same = (a: number | null, b: number | null) =>
        a === null || b === null ? a === b : Number(a) === Number(b);
      const changed = DELIVERY_PRICING_SETTINGS_FIELDS.filter(
        (field) => !same(before[field], after[field]),
      );
      if (!changed.length) {
        return { row: active, before, changed };
      }

      active.is_active = false;
      await repo.save(active);
      const next = await repo.save(
        Object.assign(repo.create(), after, {
          is_active: true,
          created_by: requester?.id ? String(requester.id) : null,
        }),
      );
      return { row: next, before, changed };
    });

    if (!outcome.changed.length) {
      return successRes(outcome.row, 200, "Sozlamalar o'zgarmadi");
    }

    await this.activityLog.logChange({
      entity_type: 'DeliveryPricingSettings',
      entity_id: String(outcome.row.id),
      action: 'logistics.delivery_pricing_settings_updated',
      old_value: outcome.before,
      new_value: this.settingsValues(outcome.row),
      description: ActivityDescribeUz.deliveryPricingSettingsUpdated(
        outcome.changed.length,
      ),
      ...this.auditActor(requester),
    });

    return successRes(
      outcome.row,
      200,
      'Yetkazish narxi sozlamalari yangilandi (yangi versiya)',
    );
  }

  private settingsValues(
    row: DeliveryPricingSettings,
  ): Record<DeliveryPricingSettingsField, number | null> {
    return Object.fromEntries(
      DELIVERY_PRICING_SETTINGS_FIELDS.map((field) => [
        field,
        row[field] === null || row[field] === undefined
          ? null
          : Number(row[field]),
      ]),
    ) as Record<DeliveryPricingSettingsField, number | null>;
  }

  private validateSettingsPatch(
    payload: UpdateDeliveryPricingSettingsPayload,
  ): Partial<Record<DeliveryPricingSettingsField, number | null>> {
    const patch: Partial<Record<DeliveryPricingSettingsField, number | null>> =
      {};
    const decimals = (n: number, places: number) =>
      Math.round(n * 10 ** places) / 10 ** places === n;
    const rules: Record<
      DeliveryPricingSettingsField,
      { ok: (n: number) => boolean; rule: string; nullable?: boolean }
    > = {
      volumetric_divisor: {
        ok: isPositiveInt,
        rule: 'musbat butun son (5000)',
      },
      first_kg_included: {
        ok: (n) => n >= 0 && n <= 1000 && decimals(n, 3),
        rule: "0..1000, ko'pi bilan 3 kasrli kg",
      },
      min_billable_kg: {
        ok: (n) => n > 0 && n <= 1000 && decimals(n, 3),
        rule: "0 dan katta, ko'pi bilan 3 kasrli kg",
      },
      billable_step_kg: {
        ok: (n) => n >= 0.001 && n <= 1000 && decimals(n, 3),
        rule: "0.001..1000, ko'pi bilan 3 kasrli kg",
      },
      round_to: { ok: isPositiveInt, rule: "musbat butun son (so'm)" },
      pickup_fee: {
        ok: (n) => n >= 0 && n <= 999_999_999_999.99 && decimals(n, 2),
        rule: "0 yoki musbat, ko'pi bilan 2 kasrli so'm",
      },
      pickup_free_from_count: {
        ok: isPositiveInt,
        rule: 'musbat butun son yoki null (hech qachon tekin emas)',
        nullable: true,
      },
      express_multiplier: {
        ok: (n) => n >= 1 && n < 1000 && decimals(n, 3),
        rule: "1 yoki undan katta, ko'pi bilan 3 kasrli son",
      },
    };

    for (const field of DELIVERY_PRICING_SETTINGS_FIELDS) {
      if (!(field in payload)) continue;
      const value = payload[field];
      if (value === undefined) continue;
      const spec = rules[field];
      if (value === null) {
        if (!spec.nullable) this.fail(`${field} — ${spec.rule}`, 400);
        patch[field] = null;
        continue;
      }
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        !spec.ok(value)
      ) {
        this.fail(`${field} — ${spec.rule}`, 400);
      }
      patch[field] = value;
    }
    return patch;
  }

  /** Birlashtirilgan sozlama formulani buzmasligi — sof funksiya bilan sinov. */
  private assertSettingsConsistent(
    values: Record<DeliveryPricingSettingsField, number | null>,
  ) {
    try {
      computeDeliveryQuote({
        items: [{ weight_kg: 1, length_cm: 1, width_cm: 1, height_cm: 1 }],
        tariff: { tariff_id: 'center', base_price: 0, extra_per_kg: 0 },
        settings: values,
        express: true,
        pickupCount: 1,
      });
    } catch (error) {
      if (error instanceof DeliveryPricingInputError) {
        this.fail(error.message, 400);
      }
      throw error;
    }
  }
}
