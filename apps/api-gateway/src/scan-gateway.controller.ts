import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  GatewayTimeoutException,
  HttpCode,
  Inject,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import {
  assertQrOrderVisible,
  canLookupOrderByQr,
} from './auth/order-qr-visibility';
import { projectOrderPayloadForRoles } from './auth/order-role-projection';
import { isOrderQrLightView, sendOrderQrLight } from './order-qr-light-view';

type ScanResponseType =
  | 'order'
  | 'batch'
  | 'post'
  | 'market_cancelled_handover';
interface JwtUser {
  sub: string;
  roles?: string[];
}

class ScanMarketCancelledHandoverQrDto {
  @IsNotEmpty()
  @IsString()
  qr_token!: string;
}

@ApiTags('Scan')
@Controller('scan')
export class ScanGatewayController {
  constructor(
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
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
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Resolve scanned QR token to order/batch/post' })
  @ApiParam({
    name: 'token',
    description: 'QR token (ORD-/BTB-/BTR-/PST- or legacy token)',
  })
  @ApiOkResponse({
    description: 'Resolved scan result',
    schema: {
      example: {
        type: 'batch',
        data: {
          id: '501',
          qr_code_token: 'BTB-a8c3d4e5',
        },
      },
    },
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
      return this.shapeResponse('batch', response);
    }

    if (prefix === 'PST-') {
      const response = await this.sendWithTimeout(
        'logistics',
        { cmd: 'logistics.post.find_by_scan' },
        { id: normalizedToken },
      );
      return this.shapeResponse('post', response);
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
      return projectOrderPayloadForRoles(req?.user?.roles, shaped);
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
      'Market canceled handover QRni scan qilib 5 daqiqalik ruxsat olish',
  })
  @ApiBody({ type: ScanMarketCancelledHandoverQrDto })
  async scanMarketCancelledHandover(
    @Body() dto: ScanMarketCancelledHandoverQrDto,
    @Req() req: { user: JwtUser },
  ) {
    const response = await this.sendWithTimeout(
      'order',
      { cmd: 'order.market_cancelled_handover.scan_qr' },
      {
        qr_token: this.normalizeToken(dto.qr_token),
        requester: {
          id: req.user.sub,
          roles: req.user.roles ?? [],
        },
      },
    );
    return this.shapeResponse('market_cancelled_handover', response);
  }
}
