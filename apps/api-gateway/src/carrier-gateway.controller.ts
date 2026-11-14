import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  GatewayTimeoutException,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiGatewayTimeoutResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiSecurity,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  CARRIER_ERROR_CODES,
  Cashbox_type,
  Order_status,
  Roles as RoleEnum,
} from '@app/common';
import { successRes } from '../../../libs/common/helpers/response';
import {
  CarrierApiKeyGuard,
  CarrierPrincipal,
} from './auth/carrier-api-key.guard';
import {
  CarrierThrottlerGuard,
  carrierThrottleLimit,
  carrierThrottleTtlMs,
  readPositiveIntEnv,
} from './auth/carrier-throttler.guard';
import { Public } from './auth/public.decorator';
import {
  CARRIER_ORDER_LIST_STATUSES,
  CARRIER_STATUS_REQUEST_EXAMPLES,
  CarrierCashboxQueryDto,
  CarrierCashboxResponseDto,
  CarrierErrorResponseDto,
  CarrierOrderListQueryDto,
  CarrierOrderListResponseDto,
  CarrierOrderStatus,
  CarrierOrderStatusRequestDto,
  CarrierPingResponseDto,
  CarrierReturnRequestDto,
  CarrierReturnResponseDto,
  CarrierScanRequestDto,
  CarrierScanResponseDto,
  CarrierStatusResponseDto,
} from './dto/carrier.swagger.dto';
import {
  isEnrichmentIncomplete,
  isOrderHeldByCourier,
  toCarrierOrderView,
  unwrapOrderRow,
} from './carrier-order-view';
import { toCarrierCashboxView } from './carrier-cashbox-view';
import { CARRIER_API_KEY_SCHEME } from './carrier-swagger';
import {
  CarrierStatusBody,
  carrierStatusRejected,
} from './carrier-status-body';
import { resolveOrderCreateRequestId } from './order-create/order-create-idempotency';
import {
  PROOF_OPERATION_TIMEOUT_MS,
  type UploadedProofFile,
  withUploadedProof,
} from './order-proof-upload';

/**
 * Per-carrier rate limit — env HAR SO'ROVDA o'qiladi (`@Throttle` resolvable,
 * `carrier-throttler.guard.ts`): bo'sh/xato qiymat sukutga tushadi.
 */
const CARRIER_THROTTLE = {
  default: { limit: carrierThrottleLimit, ttl: carrierThrottleTtlMs },
};

const CARRIER_RPC_TIMEOUT_MS = 8000;
/** Qaytarish pochtasi: har buyurtma uchun order.update — biroz uzoqroq. */
const CARRIER_RETURN_TIMEOUT_MS = 20000;

/**
 * Buyurtma topilmadi YOKI shu kurierga tegishli emas — bir xil javob.
 * Boshqa kompaniya yoki boshqa kurierning buyurtmasi BORLIGI ham bilinmasin
 * (QR/ID taxmin qilib bizning bazani "skanerlash" mumkin bo'lmasin).
 */
const NOT_YOURS_MESSAGE = 'Buyurtma topilmadi yoki sizga biriktirilmagan';

/**
 * Har bir amaldan keyin kutiladigan holat. Qayta o'qishda buyurtma shu
 * holatda emas va amaldan OLDINGI holatda qolgan bo'lsa — amal bajarilmagan
 * (eski Idempotency-Key bilan takror javob): 409 `IDEMPOTENCY_KEY_STALE`.
 */
const STATUS_TARGETS: Record<CarrierOrderStatus, readonly string[]> = {
  [CarrierOrderStatus.SOLD]: [
    Order_status.SOLD,
    Order_status.PAID,
    Order_status.PARTLY_PAID,
  ],
  [CarrierOrderStatus.PARTLY_SOLD]: [
    Order_status.SOLD,
    Order_status.PAID,
    Order_status.PARTLY_PAID,
  ],
  // Bekor + keyin qaytarilgan (`/carrier/returns`) — ayni kalit takrori ham muvaffaqiyat.
  [CarrierOrderStatus.CANCELLED]: [
    Order_status.CANCELLED,
    Order_status.CANCELLED_SENT,
    Order_status.RETURNED_TO_MARKET,
  ],
  [CarrierOrderStatus.ROLLBACK]: [Order_status.WAITING],
};

/** Postgres BIGINT chegarasi — undan kattasi DB'da 22003 (500 + requeue) berardi. */
const BIGINT_MAX = 9223372036854775807n;
export const isBigintId = (value: string): boolean =>
  /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= BIGINT_MAX;

/**
 * Skanda kurier QABUL QILADIGAN holatlar — logistics `receive_order` bilan
 * bir xil: yo'lda va mijozni kutish (`could-not-deliver` dan keyin menejer
 * qaytargan posilka ham shu kurierda qoladi).
 */
const RECEIVABLE_STATUSES: ReadonlySet<string> = new Set([
  Order_status.ON_THE_ROAD,
  Order_status.WAITING_CUSTOMER,
]);

/** logistics `receive_order` rad sababi: buyurtma yo'lda emas (400). */
const ORDER_NOT_RECEIVABLE_REASON = 'order_not_receivable';

/** partly-sell qator mosligi xatolari (order-service `partly-sell-items.ts`) — so'rov xatosi. */
const PARTLY_ITEM_NOT_FOUND = /^(Product not found|Order item not found)/i;

/**
 * Isbot fayli — file-service bilan BIR XIL qoida (`file-service.service.ts`
 * `allowedMime` / `FILE_MAX_SIZE_MB` / `FILE_MAX_VIDEO_SIZE_MB`). Gateway'da
 * oldindan tekshiriladi: ilgari 10–50 MB rasm to'liq buferlanib, RMQ orqali
 * yuborilib, keyin rad etilardi va butun status so'rovi 400 bo'lardi.
 */
const PROOF_FILE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'application/pdf',
]);
const PROOF_VIDEO_MIME = new Set([
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);
const MB = 1024 * 1024;
/** Multer chegarasi — eng katta ruxsat (video); undan oshsa 413. */
const PROOF_MULTER_MAX_BYTES = 50 * MB;

/** Kassa tarixi oynasi: sukut 30 kun, eng ko'pi 92 kun. */
const CASHBOX_DEFAULT_DAYS = 30;
const CASHBOX_MAX_DAYS = 92;
const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

const todayTashkent = (): string =>
  new Date(Date.now() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);

/** `YYYY-MM-DD` haqiqiy sanami (`2026-02-31` — yo'q). */
const isRealDay = (day: string): boolean => {
  const parsed = new Date(`${day}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day
  );
};

const shiftDay = (day: string, deltaDays: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
};

const dayDiff = (from: string, to: string): number =>
  Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() -
      new Date(`${from}T00:00:00Z`).getTime()) /
      86_400_000,
  );

/** Oddiy qiymatni satrga (obyekt `[object Object]` bo'lib ketmasin). */
const text = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'bigint'
      ? String(value)
      : '';

type CarrierRequest = {
  carrier: CarrierPrincipal;
  headers?: Record<string, unknown>;
};

/** order.sell | partly_sell | cancel | rollback_waiting `dto` (isbot kalitlari bilan). */
type CourierOpDto = {
  proofFileKeys?: string[];
  proofFileKeysVerified?: boolean;
  [key: string]: unknown;
};

type CourierRequester = {
  id: string;
  roles: string[];
  branch_id: null;
};

type Row = Record<string, unknown>;

/**
 * CARRIER API — tashqi yetkazuvchi kompaniya uchun (`X-Api-Key`, JWT emas).
 *
 * Kompaniya Elchi'da BITTA KURIER akkaunti sifatida ishlaydi
 * (`carrier_accounts.courier_user_id`). Har bir amal shu kurier nomidan
 * MAVJUD kurier RMQ buyruqlariga yo'naltiriladi (`order.sell`,
 * `order.partly_sell`, `order.cancel`, `order.rollback_waiting`,
 * `logistics.post.receive_order`, `logistics.post.cancel.create`) — ya'ni
 * egalik tekshiruvi, status mashinasi, kurier kassasi (FOR_COURIER),
 * settlement FIFO va tracking oddiy kurierdagi kabi ishlaydi; bu yerda yangi
 * pul mantiqi YO'Q.
 *
 * Ichki kurierdan farqi: QR orqali FAQAT o'ziga biriktirilgan buyurtmani
 * ko'radi (ichki kurier skaner uchun istalgan posilkani ko'ra oladi —
 * `assertQrOrderVisible`), va javob barqaror qisqa ko'rinishda
 * (`toCarrierOrderView`).
 *
 * Kontrakt: docs/public/CARRIER_API.md.
 */
@ApiTags('Carrier')
// `X-Api-Key` — Swagger'da "Authorize" tugmasi (`carrier-swagger.ts`).
@ApiSecurity(CARRIER_API_KEY_SCHEME)
@ApiExtraModels(CarrierOrderStatusRequestDto)
@ApiUnauthorizedResponse({
  description: 'X-Api-Key yo‘q yoki yaroqsiz',
  type: CarrierErrorResponseDto,
})
@ApiForbiddenResponse({
  description:
    'Akkaunt yoki bog‘langan kurier faol emas (code CARRIER_COURIER_INACTIVE), yoki IP ruxsat etilmagan',
  type: CarrierErrorResponseDto,
})
@ApiTooManyRequestsResponse({
  description: 'Limit: akkaunt uchun daqiqasiga 120 so‘rov (barcha endpoint)',
  type: CarrierErrorResponseDto,
})
@ApiServiceUnavailableResponse({
  description:
    'Vaqtinchalik xato (CARRIER_KEY_CHECK_UNAVAILABLE / CARRIER_TEMPORARILY_UNAVAILABLE) — ayni Idempotency-Key bilan qayta urining',
  type: CarrierErrorResponseDto,
})
@ApiGatewayTimeoutResponse({
  description:
    'Ichki xizmat vaqtida javob bermadi — ayni Idempotency-Key bilan qayta urining',
  type: CarrierErrorResponseDto,
})
@Throttle(CARRIER_THROTTLE)
@UseGuards(CarrierApiKeyGuard, CarrierThrottlerGuard)
@Public()
@Controller('carrier')
export class CarrierGatewayController {
  private readonly logger = new Logger(CarrierGatewayController.name);

  constructor(
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    @Optional() @Inject('FILE') private readonly fileClient?: ClientProxy,
  ) {}

  /** Downstream requester — bog'langan kurier, COURIER roli bilan. */
  private courierRequester(carrier: CarrierPrincipal): CourierRequester {
    return {
      id: carrier.courier_user_id,
      roles: [RoleEnum.COURIER],
      branch_id: null,
    };
  }

  private async send<T>(
    client: ClientProxy,
    pattern: { cmd: string },
    payload: object,
    ms = CARRIER_RPC_TIMEOUT_MS,
  ): Promise<T> {
    return firstValueFrom(
      client.send<T>(pattern, payload).pipe(timeout(ms)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException(
          'Xizmat vaqtida javob bermadi (timeout) — ayni Idempotency-Key bilan qayta urining',
        );
      }
      throw error;
    });
  }

  private statusOf(error: unknown): number {
    const e = error as { statusCode?: unknown; status?: unknown };
    return Number(e?.statusCode ?? e?.status);
  }

  private temporarilyUnavailable(detail: string): ServiceUnavailableException {
    return new ServiceUnavailableException({
      statusCode: 503,
      message: `${detail} — birozdan keyin ayni Idempotency-Key bilan qayta urining`,
      code: CARRIER_ERROR_CODES.TEMPORARILY_UNAVAILABLE,
    });
  }

  /** QR bo'yicha buyurtma (boyitilgan); topilmasa `null`. */
  private async findByQr(token: string): Promise<Row | null> {
    try {
      return unwrapOrderRow(
        await this.send(
          this.orderClient,
          { cmd: 'order.find_by_qr_enriched' },
          { token },
        ),
      );
    } catch (error) {
      if (this.statusOf(error) === 404) return null;
      throw error;
    }
  }

  /** ID bo'yicha buyurtma (boyitilgan — javob uchun); topilmasa `null`. */
  private async findById(id: string): Promise<Row | null> {
    try {
      return unwrapOrderRow(
        await this.send(
          this.orderClient,
          { cmd: 'order.find_by_id_enriched' },
          { id },
        ),
      );
    } catch (error) {
      if (this.statusOf(error) === 404) return null;
      throw error;
    }
  }

  /** ID bo'yicha XOM buyurtma (egalik/holat tekshiruvi — yengil); topilmasa `null`. */
  private async findRawById(id: string): Promise<Row | null> {
    try {
      return unwrapOrderRow(
        await this.send(this.orderClient, { cmd: 'order.find_by_id' }, { id }),
      );
    } catch (error) {
      if (this.statusOf(error) === 404) return null;
      throw error;
    }
  }

  /**
   * Kurier nomidan skan-qabul (`logistics.post.receive_order`). `false` —
   * buyurtma shu orada qabul qilinadigan holatdan chiqqan (parallel skan
   * qabul qilib bo'lgan): logistics faqat yo'ldagi buyurtmani qabul qiladi
   * va qolganini 400 `order_not_receivable` bilan rad etadi.
   */
  private async receiveByScan(
    row: Row,
    carrier: CarrierPrincipal,
  ): Promise<boolean> {
    try {
      await this.send(
        this.logisticsClient,
        { cmd: 'logistics.post.receive_order' },
        { id: text(row.id), requester: this.courierRequester(carrier) },
      );
      return true;
    } catch (error) {
      const reason = (error as { data?: { reason?: unknown } })?.data?.reason;
      if (
        this.statusOf(error) === 400 &&
        reason === ORDER_NOT_RECEIVABLE_REASON
      ) {
        return false;
      }
      throw error;
    }
  }

  /** Qayta o'qish — xatoni YUTADI (amal allaqachon bajarilgan; 5xx qaytarmaymiz). */
  private async tryRefresh(
    load: () => Promise<Row | null>,
    label: string,
  ): Promise<Row | null> {
    try {
      return await load();
    } catch (error) {
      this.logger.warn(
        `carrier: ${label} refresh failed: ${(error as Error)?.message ?? String(error)}`,
      );
      return null;
    }
  }

  /**
   * Qaytarish pochtasi shu kurierniki bo'lgan buyurtmalar (`canceled_post_id`
   * → `posts.courier_id`). `/carrier/returns` dan keyin buyurtmada
   * `courier_id` tozalanadi va egasi filial bo'ladi — lekin bu kompaniyaning
   * O'Z qaytarishi: takroriy so'rov va scan uni "begona" demasin.
   */
  private async ownReturnPostIds(
    rows: Array<Row | null>,
    courierId: string,
  ): Promise<Set<string>> {
    const postIds = [
      ...new Set(
        rows
          .filter(
            (row): row is Row =>
              !!row &&
              !isOrderHeldByCourier(row, courierId) &&
              !!text(row.canceled_post_id),
          )
          .map((row) => text(row.canceled_post_id)),
      ),
    ];
    const own = new Set<string>();
    if (!postIds.length) return own;
    const posts = await this.send<{ data?: unknown }>(
      this.logisticsClient,
      { cmd: 'logistics.post.find_by_ids' },
      { ids: postIds },
    );
    for (const post of Array.isArray(posts?.data) ? posts.data : []) {
      const p = post as { id?: unknown; courier_id?: unknown };
      if (text(p.courier_id) === courierId) own.add(text(p.id));
    }
    return own;
  }

  /** Shu kurierda (yoki o'zi qaytargan) — aks holda `false`. */
  private async isOwned(
    row: Row | null,
    carrier: CarrierPrincipal,
  ): Promise<boolean> {
    if (!row) return false;
    if (isOrderHeldByCourier(row, carrier.courier_user_id)) return true;
    const own = await this.ownReturnPostIds([row], carrier.courier_user_id);
    return own.has(text(row.canceled_post_id));
  }

  /** Buyurtma shu kurierniki — aks holda 404 (borligi bilinmaydi). */
  private async assertOwned(
    row: Row | null,
    carrier: CarrierPrincipal,
  ): Promise<Row> {
    if (!row || !(await this.isOwned(row, carrier))) {
      throw new NotFoundException(NOT_YOURS_MESSAGE);
    }
    return row;
  }

  private parseOrderId(raw: string): string {
    const id = String(raw ?? '').trim();
    if (!isBigintId(id)) {
      throw new BadRequestException("Buyurtma id noto'g'ri");
    }
    return id;
  }

  /**
   * `Idempotency-Key` MAJBURIY (pul amali, mashina mijozi qayta urinadi).
   * Ilgari ixtiyoriy edi: kalitsiz qayta urinish birinchi (commit bo'lgan)
   * amaldan keyin 400 "waiting emas" olardi va hujjat uni "tuzating, qayta
   * urinmang" deb o'qitardi — natija noaniq qolardi.
   */
  private requireIdempotencyKey(headers?: Record<string, unknown>): string {
    const raw: unknown = headers?.['idempotency-key'];
    const value = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
    const key = typeof value === 'string' ? value.trim() : '';
    if (!key) {
      throw new BadRequestException({
        statusCode: 400,
        message:
          'Idempotency-Key sarlavhasi majburiy (har yangi urinish uchun yangi UUID)',
        code: CARRIER_ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
      });
    }
    return key;
  }

  /** Isbot fayli turi va hajmi (file-service bilan bir xil qoida). */
  private assertProofFile(file: UploadedProofFile | undefined): void {
    if (!file) return;
    const mime = String(file.mimetype ?? '').toLowerCase();
    const size = file.buffer?.length ?? 0;
    if (PROOF_VIDEO_MIME.has(mime)) {
      const max = readPositiveIntEnv('FILE_MAX_VIDEO_SIZE_MB', 50) * MB;
      if (size > max) {
        throw new BadRequestException(
          `Video isbot ${Math.floor(max / MB)} MB dan oshmasin`,
        );
      }
      return;
    }
    if (!PROOF_FILE_MIME.has(mime)) {
      throw new BadRequestException(
        'Isbot fayli turi qabul qilinmaydi: rasm (jpeg, png, webp), pdf yoki video (mp4, mov, webm)',
      );
    }
    const max = readPositiveIntEnv('FILE_MAX_SIZE_MB', 10) * MB;
    if (size > max) {
      throw new BadRequestException(
        `Isbot fayli ${Math.floor(max / MB)} MB dan oshmasin (video — 50 MB)`,
      );
    }
  }

  /**
   * Kurier amali xatosini tashqi kontraktga moslaydi.
   *
   * `assertOwn` o'tgandan keyingi 404 "sizniki emas" EMAS: order-service
   * market/kurier/kassa qidiruvi RPC xatosini yutib `notFound` beradi —
   * ya'ni vaqtinchalik uzilish 404 bo'lib chiqardi va hujjat uni "qayta
   * urinmang" deb o'qitardi. Endi: partly-sell qator mosligi — 400, qolgan
   * 404 — 503 (ayni kalit bilan qayta urinish xavfsiz: muvaffaqiyatsiz
   * urinish qayta olinadi).
   */
  private mapActionError(error: unknown, label: string): unknown {
    if (this.statusOf(error) !== 404) return error;
    const message = text((error as { message?: unknown })?.message);
    if (PARTLY_ITEM_NOT_FOUND.test(message)) {
      return new BadRequestException(message);
    }
    /**
     * Doimiy holat ham bo'lishi mumkin (masalan market o'chirilgan) — u
     * qayta urinishda ham takrorlanadi. Sabab xabarda ko'rinadi va ERROR
     * logda qoladi (monitoring); hujjat: 10 daqiqadan uzoq takrorlansa —
     * `trace_id` bilan Elchi'ga murojaat.
     */
    this.logger.error(`carrier: ${label} downstream 404 → 503: ${message}`);
    return this.temporarilyUnavailable(
      `Ichki ma’lumot topilmadi (${message || 'noma’lum'})`,
    );
  }

  @Get('ping')
  @ApiOperation({
    summary: 'Kalitni tekshirish',
    description:
      'Ulanishni sinash uchun. Kalit to‘g‘ri bo‘lsa akkaunt nomini qaytaradi.',
  })
  @ApiOkResponse({ type: CarrierPingResponseDto })
  ping(@Req() req: CarrierRequest) {
    return successRes(
      {
        authenticated: true,
        carrier: { id: req.carrier.id, name: req.carrier.name },
      },
      200,
      'ok',
    );
  }

  /**
   * POSILKANI SKANERLASH (onboarding 4-bosqich).
   *
   * QR bo'yicha buyurtma topiladi; faqat shu kurierga biriktirilgan bo'lsa
   * ko'rsatiladi. Holati `on the road` bo'lsa — kurier uni QABUL QILADI
   * (`logistics.post.receive_order` → `waiting`): sotish/bekor qilish faqat
   * `waiting` holatda mumkin. Boshqa holatda faqat ma'lumot qaytadi —
   * takroriy skan xavfsiz (logistics `waiting`/yakunlangan buyurtmani qayta
   * yozmaydi).
   */
  @Post('scan')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Posilka QR skani',
    description:
      'QR bo‘yicha buyurtma ma’lumotini qaytaradi. Posilka yo‘lda (`on the road`) yoki ' +
      'mijozni kutishda (`waiting_customer`) bo‘lsa, ' +
      'shu skanda sizga qabul qilinadi (`waiting`, `received: true`) — sotish va bekor ' +
      'qilish faqat shundan keyin mumkin. Qayta skanerlash xavfsiz. Viloyat/tuman — SOATO kodi bilan.',
  })
  @ApiBody({ type: CarrierScanRequestDto })
  @ApiOkResponse({ type: CarrierScanResponseDto })
  @ApiBadRequestResponse({
    description: 'qr_token bo‘sh yoki 255 belgidan uzun',
    type: CarrierErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: NOT_YOURS_MESSAGE,
    type: CarrierErrorResponseDto,
  })
  async scan(@Body() dto: CarrierScanRequestDto, @Req() req: CarrierRequest) {
    const token = dto.qr_token.trim();
    const courierId = req.carrier.courier_user_id;
    let row = await this.assertOwned(await this.findByQr(token), req.carrier);

    let received = false;
    if (
      RECEIVABLE_STATUSES.has(text(row.status)) &&
      isOrderHeldByCourier(row, courierId)
    ) {
      received = await this.receiveByScan(row, req.carrier);
      if (!received) {
        /**
         * Parallel skan (masalan timeout'dan keyingi takror) buyurtmani shu
         * orada qabul qilib bo'lgan — bu so'rov oddiy takroriy skan: joriy
         * holat qayta o'qiladi, `received: false`.
         */
        const current = await this.tryRefresh(
          () => this.findByQr(token),
          'scan-race',
        );
        if (!current) {
          throw this.temporarilyUnavailable('Buyurtma holatini o‘qib bo‘lmadi');
        }
        row = await this.assertOwned(current, req.carrier);
      }
    }
    if (received) {
      this.logger.log(
        `carrier ${req.carrier.id} received order ${text(row.id)} by scan`,
      );
      const fresh = await this.tryRefresh(() => this.findByQr(token), 'scan');
      if (
        fresh &&
        isOrderHeldByCourier(fresh, courierId) &&
        !isEnrichmentIncomplete(fresh)
      ) {
        row = fresh;
      } else if (!isEnrichmentIncomplete(row)) {
        // Qabul BAJARILDI — oldingi (to'liq) qator, holati `waiting`.
        row = { ...row, status: Order_status.WAITING };
      } else {
        /**
         * Qabul commit bo'lgan — 503 BERMAYMIZ (qayta skan `received:false`
         * deb aldardi). Holat bilan birga, buyurtmani keyinroq o'qish kerak.
         */
        return successRes(
          { received: true, order: null, refreshed: false },
          200,
          'Posilka qabul qilindi',
        );
      }
    }

    if (isEnrichmentIncomplete(row)) {
      // SOATO / mijoz / market jimgina null bo'lib ketmasin: bir marta qayta o'qiymiz.
      const again = await this.tryRefresh(
        () => this.findByQr(token),
        'scan-enrichment',
      );
      if (
        again &&
        !isEnrichmentIncomplete(again) &&
        (await this.isOwned(again, req.carrier))
      ) {
        row = again;
      } else {
        throw this.temporarilyUnavailable(
          'Buyurtma ma’lumotini (viloyat/tuman, mijoz) to‘liq olib bo‘lmadi',
        );
      }
    }

    return successRes(
      { received, order: toCarrierOrderView(row), refreshed: true },
      200,
      received ? 'Posilka qabul qilindi' : 'Buyurtma topildi',
    );
  }

  /**
   * BUYURTMA HOLATI (onboarding 5-bosqich) — mavjud kurier amallariga
   * yo'naltiriladi. Pul oqimi oddiy kurier sotuvi bilan AYNAN bir xil
   * (FOR_COURIER kassa, settlement). Ixtiyoriy multipart `proof` — market
   * isbot talab qilsa.
   */
  @Post('orders/:id/status')
  @HttpCode(200)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'MAJBURIY (≤255 belgi). Har YANGI urinish (niyat) uchun YANGI kalit (masalan UUID). ' +
      'Ayni kalitni faqat shu so‘rovni qayta yuborishda ishlating (javob kelmadi, 409/429/5xx/504). ' +
      'Ayni kalit boshqa amal/buyurtma/tana bilan → 422; eski urinish kaliti → 409 CARRIER_IDEMPOTENCY_KEY_STALE.' +
      ' Swagger’da har sinov uchun YANGI UUID kiriting (masalan terminalda `uuidgen`) — maydon ataylab bo‘sh: bir kalitni takrorlasangiz 422/409 olasiz.',
  })
  /**
   * ⚠️ `rollback` (sold/cancelled → waiting) Swagger'da ATAYLAB YO'Q: faqat
   * admin yoqqan akkauntga ruxsat (`carrier_accounts.rollback_enabled`,
   * sukut false), o'chiq akkauntga — noma'lum status kabi 400
   * (`carrier-status-body.ts`). Ichki: `docs/ops/carrier-rollback.md`.
   */
  @ApiOperation({
    summary:
      'Buyurtma holatini yuborish: sotildi (sold), qisman (partly_sold), bekor (cancelled)',
    description:
      'Kuryeringiz posilkani topshirganda yoki topshira olmaganda shu so‘rovni yuboring — ' +
      'bizda buyurtma holati darhol o‘zgaradi. ' +
      '`sold`, `partly_sold`, `cancelled` — faqat `waiting` holatida (avval `/carrier/scan`). ' +
      '`partly_sold` da `items` buyurtmaning HAR BIR qatorini va undan sotilgan donani o‘z ichiga ' +
      'oladi; `total_price` — mijoz olgan tovarlar qiymati (onlayn to‘langan qism ham ichida). ' +
      'Xato yuborilgan natijani Elchi operatori tuzatadi. ' +
      'Sotuvchi isbot talab qilsa — `multipart/form-data` bilan `proof` fayli: rasm jpeg/png/webp ' +
      'yoki pdf ≤10 MB, video mp4/mov/webm ≤50 MB. Javobda yangilangan buyurtma ' +
      '(`refreshed: false` — holat qabul qilingan, buyurtmani keyinroq o‘qing).',
  })
  @ApiParam({
    name: 'id',
    description: 'Buyurtma id (scan javobidagi data.order.id)',
  })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiBody({
    // JSON — `CarrierOrderStatusRequestDto`; multipart'da qo'shimcha `proof`
    // (`carrier-swagger.ts` content turlari bo'yicha ajratadi).
    schema: {
      allOf: [
        { $ref: getSchemaPath(CarrierOrderStatusRequestDto) },
        {
          type: 'object',
          properties: {
            proof: {
              type: 'string',
              format: 'binary',
              description: 'Ixtiyoriy isbot fayli (faqat multipart)',
            },
          },
        },
      ],
    },
    // Tayyor misollar — faqat JSON'da qoladi (`splitMultipartProofBodies`).
    examples: CARRIER_STATUS_REQUEST_EXAMPLES,
  })
  @ApiOkResponse({ type: CarrierStatusResponseDto })
  @ApiBadRequestResponse({
    description:
      'Maydon xato, Idempotency-Key yo‘q, isbot fayli mos emas yoki buyurtma bu amal uchun mos holatda emas',
    type: CarrierErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: NOT_YOURS_MESSAGE,
    type: CarrierErrorResponseDto,
  })
  @ApiConflictResponse({
    description:
      'Ayni kalit bilan so‘rov hali bajarilmoqda (biroz kutib qayta urining) yoki kalit eski urinishga tegishli (CARRIER_IDEMPOTENCY_KEY_STALE — yangi kalit)',
    type: CarrierErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Shu Idempotency-Key boshqa amal/buyurtma/tana bilan ishlatilgan',
    type: CarrierErrorResponseDto,
  })
  @ApiPayloadTooLargeResponse({
    description: 'Isbot fayli 50 MB dan katta',
    type: CarrierErrorResponseDto,
  })
  @UseInterceptors(
    FileInterceptor('proof', {
      storage: memoryStorage(),
      limits: { fileSize: PROOF_MULTER_MAX_BYTES, files: 1 },
    }),
  )
  async updateStatus(
    @Param('id') rawId: string,
    // `@Body()` EMAS: tana akkauntning rollback ruxsatiga qarab tekshiriladi.
    @CarrierStatusBody() dto: CarrierOrderStatusRequestDto,
    @UploadedFile() proof: UploadedProofFile | undefined,
    @Req() req: CarrierRequest,
  ) {
    /**
     * Himoya (pipe chetlab o'tilsa ham): rollback o'chiq akkaunt — noma'lum
     * status bilan AYNI 400, HAR QANDAY amaldan oldin (buyurtma o'qilmaydi,
     * Idempotency-Key tekshirilmaydi/ishlatilmaydi, RMQ amali yo'q).
     */
    if (
      dto.status === CarrierOrderStatus.ROLLBACK &&
      req.carrier.rollback_enabled !== true
    ) {
      throw carrierStatusRejected();
    }
    const id = this.parseOrderId(rawId);
    const idempotencyKey = this.requireIdempotencyKey(req.headers);
    const requester = this.courierRequester(req.carrier);
    // Kalit uzunligi (≤255) shu yerda tekshiriladi (aks holda 400).
    const requestId = resolveOrderCreateRequestId(requester.id, idempotencyKey);

    const before = await this.assertOwned(
      await this.findRawById(id),
      req.carrier,
    );

    if (dto.status === CarrierOrderStatus.ROLLBACK && proof) {
      throw new BadRequestException('rollback uchun proof kerak emas');
    }
    this.assertProofFile(proof);
    const uploader = {
      sub: requester.id,
      roles: requester.roles,
      branch_id: null,
    };

    let pattern: { cmd: string };
    let orderDto: CourierOpDto;
    let ms = PROOF_OPERATION_TIMEOUT_MS;

    switch (dto.status) {
      case CarrierOrderStatus.SOLD:
        pattern = { cmd: 'order.sell' };
        orderDto = await withUploadedProof<CourierOpDto>(
          this.fileClient,
          {
            comment: dto.comment,
            oldItemCollected: dto.old_item_collected,
          },
          proof,
          uploader,
        );
        break;
      case CarrierOrderStatus.PARTLY_SOLD:
        pattern = { cmd: 'order.partly_sell' };
        orderDto = await withUploadedProof<CourierOpDto>(
          this.fileClient,
          {
            order_item_info: (dto.items ?? []).map((item) => ({
              ...(item.order_item_id
                ? { order_item_id: item.order_item_id }
                : {}),
              ...(item.product_id ? { product_id: item.product_id } : {}),
              quantity: item.quantity,
            })),
            totalPrice: dto.total_price,
            comment: dto.comment,
            oldItemCollected: dto.old_item_collected,
          },
          proof,
          uploader,
        );
        break;
      case CarrierOrderStatus.CANCELLED:
        pattern = { cmd: 'order.cancel' };
        orderDto = await withUploadedProof<CourierOpDto>(
          this.fileClient,
          { reason: dto.reason, comment: dto.comment },
          proof,
          uploader,
        );
        break;
      case CarrierOrderStatus.ROLLBACK:
        pattern = { cmd: 'order.rollback_waiting' };
        orderDto = { target_status: 'waiting' };
        ms = CARRIER_RPC_TIMEOUT_MS;
        break;
      default:
        // Faqat ochiq qiymatlar sanaladi (rollback hech qachon oshkor qilinmaydi).
        throw carrierStatusRejected();
    }

    // `undefined` maydonlar RMQ'ga ketmaydi — order-service DTO'si toza qolsin.
    const cleanDto = Object.fromEntries(
      Object.entries(orderDto).filter(([, value]) => value !== undefined),
    );

    try {
      await this.send(
        this.orderClient,
        pattern,
        { id, dto: cleanDto, requester, request_id: requestId },
        ms,
      );
    } catch (error) {
      throw this.mapActionError(error, `${pattern.cmd} order ${id}`);
    }
    this.logger.log(
      `carrier ${req.carrier.id} (${req.carrier.name}) → ${pattern.cmd} order ${id}`,
    );

    /**
     * ESKI KALIT (ultracode review, HIGH). order-service courier-op kaliti
     * `amal:buyurtma:tana` ga bog'lanadi va muddatsiz saqlanadi: sold →
     * rollback (kompaniya — faqat ruxsati yoqiq bo'lsa — yoki Elchi
     * operatori) → sold ayni kalit bilan ikkinchi sotuvni BAJARMAY birinchi
     * natijani qaytarardi. Buyurtma kutilgan holatga o'tmagan va amaldan
     * oldingi holatida qolgan bo'lsa — bu shunday "jim" takror: 409.
     *
     * Tekshiruv XOM qayta o'qishda (boyitishga — logistics/identity'ga —
     * bog'liq emas): ilgari boyitilgan o'qish yiqilsa tekshiruv o'tkazib
     * yuborilib, jim takror "qabul qilindi" bo'lib qaytardi. Xom o'qish ham
     * yiqilsa — 503: ayni kalit bilan takror xavfsiz (keshdan javob).
     */
    const afterRaw = await this.tryRefresh(
      () => this.findRawById(id),
      'status-raw',
    );
    if (!afterRaw) {
      throw this.temporarilyUnavailable('Holatni tasdiqlab bo‘lmadi');
    }
    const afterStatus = text(afterRaw.status);
    if (
      !STATUS_TARGETS[dto.status].includes(afterStatus) &&
      afterStatus === text(before.status)
    ) {
      throw new ConflictException({
        statusCode: 409,
        message:
          'Bu Idempotency-Key oldingi urinishga tegishli — amal qayta bajarilmadi. Yangi kalit bilan yuboring',
        code: CARRIER_ERROR_CODES.IDEMPOTENCY_KEY_STALE,
      });
    }

    /**
     * AMAL BAJARILDI. Javob uchun boyitilgan o'qish — uning xatosi 5xx
     * BERMAYDI (ilgari commit'dan keyingi 504/500 kalitsiz qayta urinishni
     * 400 ga olib borardi). O'qib bo'lmasa — `order: null, refreshed: false`.
     */
    const after = await this.tryRefresh(() => this.findById(id), 'status');
    if (
      !after ||
      isEnrichmentIncomplete(after) ||
      !(await this.isOwned(after, req.carrier))
    ) {
      return successRes(
        { order: null, refreshed: false },
        200,
        'Holat qabul qilindi',
      );
    }

    return successRes(
      { order: toCarrierOrderView(after), refreshed: true },
      200,
      'Holat qabul qilindi',
    );
  }

  /**
   * BEKOR QILINGAN POSILKANI QAYTARISH (ultracode review). `cancelled` va
   * qisman sotuvdan ajralgan qism kompaniya qo'lida (holder = kurier) qoladi;
   * ilgari ularni Elchi'ga qaytarishning API yo'li yo'q edi. Mavjud kurier
   * buyrug'i (`logistics.post.cancel.create`) qaytarish pochtasini ochadi —
   * buyurtmalar `cancelled (sent)` bo'ladi, filial pochtani qabul qiladi.
   *
   * Takror xavfsiz: shu kurierning qaytarish pochtasiga allaqachon tushgan
   * buyurtma (`cancelled (sent)`) qayta so'ralsa — o'sha pochta qaytadi.
   */
  @Post('returns')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Bekor qilingan posilkalarni Elchi filialiga qaytarish',
    description:
      'Sizda turgan `cancelled` holatidagi posilkalar (qisman sotuvdan ajralgan qism ham) uchun ' +
      'qaytarish pochtasi ochiladi — holati `cancelled (sent)`. Posilkalarni Elchi filialiga ' +
      'topshirasiz, filial pochtani qabul qiladi. Takroriy so‘rov xavfsiz.',
  })
  @ApiBody({ type: CarrierReturnRequestDto })
  @ApiOkResponse({ type: CarrierReturnResponseDto })
  @ApiBadRequestResponse({
    description: 'Ro‘yxatda `cancelled` holatida bo‘lmagan posilka bor',
    type: CarrierErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: `${NOT_YOURS_MESSAGE} (id’lar xabarda)`,
    type: CarrierErrorResponseDto,
  })
  async returns(
    @Body() dto: CarrierReturnRequestDto,
    @Req() req: CarrierRequest,
  ) {
    const courierId = req.carrier.courier_user_id;
    const ids = [...new Set(dto.order_ids.map((id) => id.trim()))];
    const badIds = ids.filter((id) => !isBigintId(id));
    if (badIds.length) {
      throw new BadRequestException(
        `Buyurtma id noto'g'ri: ${badIds.join(', ')}`,
      );
    }
    const rows = await Promise.all(ids.map((id) => this.findRawById(id)));

    // Allaqachon qaytarilganlar — shu kurierning qaytarish pochtasida (filial
    // qabul qilgan bo'lsa ham): takroriy so'rov o'sha pochtani qaytaradi.
    const ownSentPosts = await this.ownReturnPostIds(rows, courierId);

    const toSend: string[] = [];
    const alreadySent: Row[] = [];
    const notYours: string[] = [];
    const wrongStatus: string[] = [];
    ids.forEach((id, index) => {
      const row = rows[index];
      if (
        row &&
        !isOrderHeldByCourier(row, courierId) &&
        ownSentPosts.has(text(row.canceled_post_id))
      ) {
        alreadySent.push(row);
      } else if (!row || !isOrderHeldByCourier(row, courierId)) {
        notYours.push(id);
      } else if (row.status !== Order_status.CANCELLED) {
        wrongStatus.push(`${id} (${text(row.status)})`);
      } else {
        toSend.push(id);
      }
    });
    if (notYours.length) {
      throw new NotFoundException(
        `${NOT_YOURS_MESSAGE}: ${notYours.join(', ')}`,
      );
    }
    if (wrongStatus.length) {
      throw new BadRequestException(
        `Faqat bekor qilingan (cancelled) posilkani qaytarish mumkin: ${wrongStatus.join(', ')}`,
      );
    }

    let postId = alreadySent.length
      ? text(alreadySent[0].canceled_post_id)
      : '';
    if (toSend.length) {
      const res = await this.send<{ data?: { post_id?: unknown } }>(
        this.logisticsClient,
        { cmd: 'logistics.post.cancel.create' },
        {
          dto: { order_ids: toSend },
          requester: this.courierRequester(req.carrier),
        },
        CARRIER_RETURN_TIMEOUT_MS,
      );
      postId = text(res?.data?.post_id) || postId;
      this.logger.log(
        `carrier ${req.carrier.id} returned ${toSend.length} cancelled order(s) → post ${postId}`,
      );
    }

    return successRes(
      { post_id: postId, order_ids: ids },
      200,
      'Qaytarish pochtasi tayyor',
    );
  }

  /** Shu kurierdagi buyurtmalar (solishtirish uchun). */
  @Get('orders')
  @ApiOperation({
    summary: 'Menga biriktirilgan buyurtmalar ro‘yxati',
    description:
      'Solishtirish uchun: sizga biriktirilgan yoki hozir qo‘lingizdagi buyurtmalar. ' +
      '`status` — vergul bilan bir nechta holat. `from`/`to` — BUYURTMA YARATILGAN kun ' +
      '(Toshkent vaqti).',
  })
  @ApiOkResponse({ type: CarrierOrderListResponseDto })
  @ApiBadRequestResponse({
    description: 'Noma’lum holat yoki sana formati xato',
    type: CarrierErrorResponseDto,
  })
  async listOrders(
    @Query() query: CarrierOrderListQueryDto,
    @Req() req: CarrierRequest,
  ) {
    const statuses = String(query.status ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = statuses.filter(
      (s) => !CARRIER_ORDER_LIST_STATUSES.includes(s),
    );
    if (unknown.length) {
      throw new BadRequestException(`Noma'lum holat: ${unknown.join(', ')}`);
    }
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;

    const response = await this.send<{
      data?: unknown[];
      total?: number;
    }>(
      this.orderClient,
      { cmd: 'order.find_all_enriched' },
      {
        query: {
          // `courier_id OR holder_courier_id` — GET /orders kurier doirasi bilan bir xil.
          courier_ids: [req.carrier.courier_user_id],
          ...(statuses.length ? { status: statuses } : {}),
          ...(query.from ? { start_day: query.from } : {}),
          ...(query.to ? { end_day: query.to } : {}),
          page,
          limit,
        },
      },
    );

    const rows = (Array.isArray(response?.data) ? response.data : [])
      .map((r) => unwrapOrderRow(r))
      .filter((r): r is Row => !!r)
      // Himoya qatlami: order-service doirasi o'zgarsa ham begona qator chiqmasin.
      .filter((r) => isOrderHeldByCourier(r, req.carrier.courier_user_id));
    // Geo boyitish yetmagan bo'lsa — SOATO'siz ro'yxat bermaymiz (vaqtinchalik).
    if (rows.some((r) => isEnrichmentIncomplete(r))) {
      throw this.temporarilyUnavailable(
        'Buyurtma ma’lumotini (viloyat/tuman, mijoz) to‘liq olib bo‘lmadi',
      );
    }
    return successRes(
      {
        items: rows.map((r) => toCarrierOrderView(r)),
        total: Number(response?.total ?? 0),
        page,
        limit,
      },
      200,
      'orders',
    );
  }

  /**
   * Kurier kassasi (onboarding 6–7-bosqich): balans va tarix — sotuvdan
   * tushgan summa (kirim) va bizga topshirilgan naqd (chiqim).
   *
   * Tarix OYNA bilan (sukut — oxirgi 30 kun, eng ko'pi 92 kun): finance
   * tarixni sahifalamaydi, bitta kurier = butun kompaniya, ya'ni oynasiz
   * so'rov vaqt o'tib doim timeout bo'lardi. Balans oynaga bog'liq emas.
   */
  @Get('cashbox')
  @ApiOperation({
    summary: 'Kassa: balans va harakatlar tarixi',
    description:
      '`balance` — Elchi’ga topshirilishi kerak bo‘lgan summa (oynaga bog‘liq emas). Tarix — ' +
      '`from`..`to` (Toshkent kunlari, sukut: oxirgi 30 kun, eng ko‘pi 92 kun). Yo‘nalish ' +
      '`type` dan (income/expense), `amount` doim musbat. Xodim ma’lumotlari qaytmaydi.',
  })
  @ApiOkResponse({ type: CarrierCashboxResponseDto })
  @ApiBadRequestResponse({
    description: 'Sana formati xato, from > to yoki oraliq 92 kundan uzun',
    type: CarrierErrorResponseDto,
  })
  async cashbox(
    @Query() query: CarrierCashboxQueryDto,
    @Req() req: CarrierRequest,
  ) {
    const to = query.to ?? todayTashkent();
    const from = query.from ?? shiftDay(to, -(CASHBOX_DEFAULT_DAYS - 1));
    if (!isRealDay(from) || !isRealDay(to)) {
      throw new BadRequestException("Sana noto'g'ri (YYYY-MM-DD)");
    }
    const span = dayDiff(from, to);
    if (span < 0) {
      throw new BadRequestException('from to dan keyin bo‘lmasin');
    }
    if (span + 1 > CASHBOX_MAX_DAYS) {
      throw new BadRequestException(
        `Oraliq ${CASHBOX_MAX_DAYS} kundan oshmasin — bo‘lib so‘rang`,
      );
    }

    const response = await this.send(
      this.financeClient,
      { cmd: 'finance.cashbox.my' },
      {
        user_id: req.carrier.courier_user_id,
        roles: [RoleEnum.COURIER],
        cashbox_type: Cashbox_type.FOR_COURIER,
        fromDate: from,
        toDate: to,
      },
    );
    // Xom finance javobi (xodim ismi/telefoni, dedup tokenlari) tashqariga chiqmaydi.
    return successRes(
      { from, to, ...toCarrierCashboxView(response) },
      200,
      'cashbox',
    );
  }
}
