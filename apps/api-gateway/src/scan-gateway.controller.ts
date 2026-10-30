import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  GatewayTimeoutException,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, ValidateIf } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { SCAN_THROTTLE } from './auth/scan-throttle';
import {
  assertQrOrderVisible,
  canLookupOrderByQr,
} from './auth/order-qr-visibility';
import { projectOrderPayloadForRoles } from './auth/order-role-projection';
import {
  ProblemContactsService,
  attachProblemContacts,
} from './contacts/problem-contacts.service';
import {
  canScanPost,
  isPostScanToken,
  POST_SCAN_FORBIDDEN_MESSAGE,
} from './auth/post-scan-access';
import { isOrderQrLightView, sendOrderQrLight } from './order-qr-light-view';

type ScanResponseType =
  | 'order'
  | 'batch'
  | 'post'
  | 'market_cancelled_handover';
interface JwtUser {
  sub: string;
  roles?: string[];
  branch_id?: string | null;
}

/**
 * `POST /scan/market-cancelled` tanasi — IKKI shakl (zkRab9M2, BG6):
 *   - `{ qr_token }`        — market QR'i skanerlandi (avvalgidek);
 *   - `{ market_id, pin }`  — market ekranidagi 6 xonali kod qo'lda yozildi.
 * Ikkalasi birga — 400 (qaysi yo'l ekani noaniq bo'lmasin).
 */
export class ScanMarketCancelledHandoverQrDto {
  @ApiPropertyOptional({
    description: 'Market QR tokeni (`MCR-…`). `pin` yuborilmasa majburiy.',
    example: 'MCR-3q2x…',
  })
  @ValidateIf((dto: ScanMarketCancelledHandoverQrDto) => dto.pin === undefined)
  @IsNotEmpty()
  @IsString()
  qr_token?: string;

  @ApiPropertyOptional({
    description:
      'zkRab9M2: kod bilan tasdiqlashda market ID (raqam). `pin` bilan birga majburiy.',
    example: '16',
  })
  @ValidateIf(
    (dto: ScanMarketCancelledHandoverQrDto) =>
      dto.pin !== undefined || dto.market_id !== undefined,
  )
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'number' ? String(value) : value,
  )
  @IsString()
  @Matches(/^\d{1,18}$/, { message: "market_id raqam bo'lishi kerak" })
  market_id?: string;

  @ApiPropertyOptional({
    description:
      'zkRab9M2: market ekranidagi 6 xonali kod (QR bilan bir xil 2 daqiqa amal qiladi). 5 marta xato — sessiya bloklanadi, market yangi QR chiqaradi.',
    example: '042917',
  })
  @ValidateIf(
    (dto: ScanMarketCancelledHandoverQrDto) =>
      dto.pin !== undefined || dto.market_id !== undefined,
  )
  @IsString()
  @Matches(/^\d{6}$/, { message: "pin 6 ta raqamdan iborat bo'lishi kerak" })
  pin?: string;
}

@ApiTags('Scan')
@Controller('scan')
export class ScanGatewayController {
  constructor(
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    // T7 (QPq2C1co, B2): skan qilingan buyurtma/pochtaga `problem_contacts`.
    // Yo'q (eski spec'lar) — maydon qo'shilmaydi.
    @Optional() private readonly problemContacts?: ProblemContactsService,
  ) {}

  private normalizeToken(token: string): string {
    return String(token ?? '').trim();
  }

  private extractPrefix(token: string): string {
    return token.slice(0, 4).toUpperCase();
  }

  private async sendWithTimeout(
    service: 'order' | 'branch' | 'logistics',
    pattern: { cmd: string },
    payload: Record<string, unknown>,
  ) {
    const client =
      service === 'order'
        ? this.orderClient
        : service === 'branch'
          ? this.branchClient
          : this.logisticsClient;

    return firstValueFrom(
      client.send(pattern, payload).pipe(timeout(8000)),
    ).catch((error) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException(
          `${service} service response timeout`,
        );
      }
      throw error;
    });
  }

  private shapeResponse(type: ScanResponseType, response: any) {
    return {
      type,
      data: response?.data ?? response,
    };
  }

  /**
   * RMQ xatosi "topilmadi" (404) mi? Order-service `RpcException({statusCode})`
   * tashlaydi — mikroservis uni plain obyekt ({statusCode,message}) sifatida
   * yuboradi, lekin ehtiyot uchun RpcException instance holatini ham qamraymiz.
   * Timeout ALOHIDA ushlanadi (GatewayTimeoutException) — u 404 EMAS.
   */
  private isNotFoundRpcError(error: unknown): boolean {
    if (error instanceof GatewayTimeoutException) return false;
    const raw: { statusCode?: number; status?: number } =
      error && typeof (error as { getError?: unknown }).getError === 'function'
        ? (
            error as {
              getError: () => { statusCode?: number; status?: number };
            }
          ).getError()
        : ((error as { statusCode?: number; status?: number }) ?? {});
    return raw?.statusCode === 404 || raw?.status === 404;
  }

  @Get(':token')
  // R6R8BLGA: filial bitta IP — ketma-ket kamera skani uchun yuqoriroq limit.
  @Throttle(SCAN_THROTTLE)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Resolve scanned QR token to order/batch/post',
    description:
      "Prefiks bo'yicha: `BTB-`/`BTR-` → paket (`type: batch`), `POST-` (logistics haqiqiy shakli) / `PST-` → pochta (`type: post`), qolgani → buyurtma (404 bo'lsa tashqi qop). " +
      "j8hdXE1o: paketni jo'natuvchi YOKI qabul qiluvchi filial xodimi ko'radi (`GET /transfer-batches/:id` bilan bir xil). " +
      "dwJX3NjT: paket javobida qo'shimcha `source_branch` / `destination_branch` `{id, name}`, `region` `{id, name}` va `items[].order` — buyurtma xulosasi `{id, order_number, status, total_price, region, district, customer {name, phone_number}}` (xulosa xizmati javob bermasa `null`). " +
      "X4RzXk1H: pochta — faqat superadmin/admin/branch/manager/registrator/courier (boshqalar 403) va `GET /post/orders/:id` doirasi (filial xodimi — o'z filiali, kuryer — o'z pochtasi); javob `GET /post/scan/:id` bilan bir xil: pochta qatori + `region`, `courier`, `orders[]`.",
  })
  @ApiParam({
    name: 'token',
    description: 'QR token (ORD-/BTB-/BTR-/POST-/PST- or legacy token)',
  })
  @ApiOkResponse({
    description: 'Resolved scan result',
    schema: {
      example: {
        type: 'batch',
        data: {
          id: '501',
          qr_code_token: 'BTB-a8c3d4e5',
          status: 'SENT',
          order_count: 1,
          total_price: 65000,
          source_branch_id: '1',
          destination_branch_id: '3',
          target_region_id: '6',
          source_branch: { id: '1', name: 'Bosh ofis' },
          destination_branch: { id: '3', name: 'QA filial' },
          region: { id: '6', name: 'Buxoro viloyati' },
          items: [
            {
              id: '9001',
              order_id: '700',
              snapshot_price: 65000,
              order: {
                id: '700',
                order_number: 'EL-100700',
                status: 'on the road',
                total_price: 65000,
                region: 'Buxoro viloyati',
                district: 'Buxoro tumani',
                customer: {
                  name: 'Ali Valiyev',
                  phone_number: '+998901234567',
                },
              },
            },
          ],
        },
      },
    },
  })
  @ApiForbiddenResponse({
    description:
      "Paket: so'rovchi jo'natuvchi filialni ham, qabul qiluvchi filialni ham o'qiy olmaydi. Pochta: rol yoki doira (filial / o'z pochtasi) mos emas.",
  })
  @ApiNotFoundResponse({ description: 'Topilmadi' })
  @ApiQuery({
    name: 'view',
    required: false,
    enum: ['light'],
    description:
      "D148eHMA: `light` — buyurtma tokeni uchun skaner ekraniga yengil javob. Paket/pochta tokenlariga ta'sir qilmaydi.",
  })
  async scan(
    @Param('token') token: string,
    @Req() req: { user: JwtUser },
    @Query('view') view?: string,
  ) {
    const normalizedToken = this.normalizeToken(token);
    const prefix = this.extractPrefix(normalizedToken);

    if (prefix === 'BTB-' || prefix === 'BTR-') {
      const response = await this.sendWithTimeout(
        'branch',
        { cmd: 'branch.transfer_batch.find_by_token' },
        {
          token: normalizedToken,
          requester: { id: req.user.sub, roles: req.user.roles ?? [] },
        },
      );
      // dwJX3NjT: `items[].order` — buyurtma xulosasi; rol proyeksiyasi
      // (kH2zZsz3) himoya qatlami sifatida ham qo'llanadi.
      return projectOrderPayloadForRoles(
        req?.user?.roles,
        this.shapeResponse('batch', response),
      );
    }

    // X4RzXk1H: haqiqiy pochta tokeni `POST-…` (5 belgili prefiks) — ilgari
    // 4 belgili `POST` hech narsaga mos kelmay buyurtma tarmog'iga tushardi
    // (404). Rol shu yerda, filial/kuryer doirasi logistics'da tekshiriladi.
    if (isPostScanToken(normalizedToken)) {
      if (!canScanPost(req?.user?.roles)) {
        throw new ForbiddenException(POST_SCAN_FORBIDDEN_MESSAGE);
      }
      const response = await this.sendWithTimeout(
        'logistics',
        { cmd: 'logistics.post.find_by_scan' },
        {
          id: normalizedToken,
          requester: {
            id: req.user.sub,
            roles: req.user.roles ?? [],
            branch_id: req.user.branch_id ?? null,
          },
        },
      );
      return projectOrderPayloadForRoles(
        req?.user?.roles,
        await attachProblemContacts(
          this.problemContacts,
          this.shapeResponse('post', response),
        ),
      );
    }

    // ORD- prefixed and legacy prefixless tokens both resolve as order.
    // fix3 C11 (CODE-04): `GET /orders/qr-code/:token` bilan AYNI qoida —
    // ilgari bu yo'l rol tekshiruvisiz edi (mijoz/investor/operator ham
    // buyurtma va mijoz ma'lumotini olardi), market esa begona posilkani.
    if (!canLookupOrderByQr(req?.user?.roles)) {
      throw new ForbiddenException("Bu buyurtmani ko'rishga ruxsat yo'q");
    }
    try {
      // D148eHMA — `?view=light` OPT-IN; parametrsiz so'rov AYNAN avvalgidek.
      // 404 yengil yo'lda ham shu yerga tushadi -> quyida QOP qidiruvi.
      const response: unknown = isOrderQrLightView(view)
        ? await sendOrderQrLight(
            (pattern) =>
              this.sendWithTimeout('order', pattern, {
                token: normalizedToken,
              }),
            // Fallback — to'liq (enriched) javob: yengilning ustki to'plami.
            { cmd: 'order.find_by_qr_enriched' },
          )
        : await this.sendWithTimeout(
            'order',
            { cmd: 'order.find_by_qr' },
            { token: normalizedToken },
          );
      const shaped = this.shapeResponse('order', response);
      assertQrOrderVisible(req?.user, shaped.data);
      // kH2zZsz3: skan qilingan buyurtma `GET /orders/:id` bilan AYNI rol
      // proyeksiyasida — kuryer market tarifi/filial ulushini, market esa
      // kuryer tarifi/ulushini ko'rmaydi.
      // T7: `problem_contacts` proyeksiyadan OLDIN.
      return projectOrderPayloadForRoles(
        req?.user?.roles,
        await attachProblemContacts(this.problemContacts, shaped),
      );
    } catch (error) {
      /**
       * CyCV4XHR — buyurtma topilmadi. Token QOP (`external_batch_token`)
       * bo'lishi mumkin: BeePost qop yorlig'i ORD-/BTB- prefiksiz keladi,
       * shuning uchun shu (prefiksiz) yo'lga tushadi va posilka emasligi uchun
       * 404 beradi. FAQAT 404 da qop bo'yicha qidiramiz (timeout/boshqa xato
       * yashirilmasin). Qop ham topilmasa, batch lookup o'z 404'ini tashlaydi.
       */
      if (!this.isNotFoundRpcError(error)) {
        throw error;
      }
      const batch: unknown = await this.sendWithTimeout(
        'order',
        { cmd: 'order.find_batch_by_external_token' },
        { token: normalizedToken },
      );
      return this.shapeResponse('batch', batch);
    }
  }

  @Post('market-cancelled')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Market canceled handover QRni scan qilib (yoki 6 xonali kod bilan) 5 daqiqalik ruxsat olish',
    description:
      'Tana: `{ qr_token }` (QR skani) YOKI `{ market_id, pin }` (zkRab9M2 — market ekranidagi 6 xonali kod). ' +
      "Javob ikkalasida bir xil: `{ type: 'market_cancelled_handover', data: { market_id, authorized: true, authorization_token: 'MHA-…', authorized_at, expires_at, remaining_seconds: 300, method: 'qr' | 'pin' } }`. " +
      "Rollar — superadmin/admin (HQ), menejer/registrator (o'z filiali). Kod xatolari 400 + `data.reason`: " +
      '`market_cancelled_pin_invalid` (`data.details.remaining_attempts`, `max_attempts: 5`), ' +
      '`market_cancelled_pin_blocked` (5 xato — sessiya QR bilan ham ochilmaydi, market yangi QR chiqarsin), ' +
      '`market_cancelled_pin_expired`, `market_cancelled_pin_not_found` (faol QR yo‘q). ' +
      'Kod bilan ochilgan ruxsatda topshirish usuli `pin` (`orders.market_handover_method`, tracking `metadata.method`).',
  })
  @ApiBody({ type: ScanMarketCancelledHandoverQrDto })
  async scanMarketCancelledHandover(
    @Body() dto: ScanMarketCancelledHandoverQrDto,
    @Req() req: { user: JwtUser },
  ) {
    const requester = {
      id: req.user.sub,
      roles: req.user.roles ?? [],
    };

    // zkRab9M2 (BG6): kod yo'li — QR tokeni bilan aralashtirilmaydi.
    if (dto.pin !== undefined) {
      if (dto.qr_token !== undefined) {
        throw new BadRequestException(
          'qr_token yoki pin — faqat bittasini yuboring',
        );
      }
      const response = await this.sendWithTimeout(
        'order',
        { cmd: 'order.market_cancelled_handover.verify_pin' },
        {
          market_id: String(dto.market_id ?? '').trim(),
          pin: String(dto.pin).trim(),
          requester,
        },
      );
      return this.shapeResponse('market_cancelled_handover', response);
    }

    const response = await this.sendWithTimeout(
      'order',
      { cmd: 'order.market_cancelled_handover.scan_qr' },
      {
        qr_token: this.normalizeToken(dto.qr_token ?? ''),
        requester,
      },
    );
    return this.shapeResponse('market_cancelled_handover', response);
  }
}
