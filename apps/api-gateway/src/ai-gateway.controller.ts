import {
  BadRequestException,
  Body,
  Controller,
  GatewayTimeoutException,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { firstValueFrom, Observable, TimeoutError, timeout } from 'rxjs';
import { RMQ_GATEWAY_TIMEOUT, Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  AiUsageSummaryQueryDto,
  RaiseAiCapRequestDto,
} from './dto/ai.swagger.dto';
import { successRes } from '../../../libs/common/helpers/response';

interface AuthedRequest {
  user?: { sub?: string | number; roles?: string[] };
}

/**
 * AI admin endpointlari (PLAN C8; kartalar wFSMEIIy, lYVuADRE, bVeyEuIR):
 *  - `GET  /ai/status`         — kalit holati, modellar, bugungi shift (SUPERADMIN, ADMIN);
 *  - `POST /ai/cap/raise`      — bugungi shiftni bir martalik ko'tarish, audit bilan (SUPERADMIN);
 *  - `GET  /ai/usage/summary`  — xarajat jurnali yig'indisi (SUPERADMIN, ADMIN).
 *
 * ⚠️ Hech biri Anthropic'ni chaqirmaydi — faqat ai-service'ning DB/holat
 * handler'lari. Har `send` `timeout(RMQ_GATEWAY_TIMEOUT)` bilan, qayta
 * urinishsiz (ai.* RPC). Timeout → 504 (GatewayTimeoutException).
 * `ai.status` javobida kalit QIYMATI yo'q — faqat holat (`key_state`).
 */
@ApiTags('AI')
@ApiBearerAuth()
@Controller('ai')
export class AiGatewayController {
  constructor(@Inject('AI') private readonly aiClient: ClientProxy) {}

  @Get('status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary:
      'AI holati: kalit holati (qiymatsiz), modellar, bugungi global shift',
  })
  async status() {
    const data = await this.call(
      this.aiClient
        .send<unknown>({ cmd: 'ai.status' }, {})
        .pipe(timeout(RMQ_GATEWAY_TIMEOUT)),
    );
    return successRes(data);
  }

  /**
   * Global kunlik shiftni FAQAT BUGUN uchun ko'tarish (wFSMEIIy #10) — noto'g'ri
   * sozlangan shift butun AI oqimini jimgina o'chirib qo'ymasligi uchun.
   * `requester` ai-service'da ai_schema.activity_logs ga audit sifatida yoziladi.
   */
  @Post('cap/raise')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiOperation({
    summary: 'AI kunlik shiftini bugun uchun bir martalik ko‘tarish (audit)',
  })
  @ApiBody({ type: RaiseAiCapRequestDto })
  async raiseCap(@Body() dto: RaiseAiCapRequestDto, @Req() req: AuthedRequest) {
    const data = await this.call(
      this.aiClient
        .send<unknown>(
          { cmd: 'ai.cap.raise' },
          {
            extra_usd: dto.extra_usd,
            reason: dto.reason,
            requester: {
              id: String(req.user?.sub ?? ''),
              roles: Array.isArray(req.user?.roles) ? req.user.roles : [],
            },
          },
        )
        .pipe(timeout(RMQ_GATEWAY_TIMEOUT)),
    );
    return successRes(data);
  }

  /**
   * AI xarajat jurnali yig'indisi (lYVuADRE): jami USD/so'm, chaqiruvlar,
   * kesh tejami, meta'si to'liq bo'lmagan chaqiruvlar, buyurtmaga bog'langan
   * chaqiruvlar, feature va kun kesimida. Sana berilmasa oxirgi 30 kun.
   */
  @Get('usage/summary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({
    summary: 'AI xarajat yig‘indisi (from/to — YYYY-MM-DD, Toshkent)',
  })
  async usageSummary(@Query() query: AiUsageSummaryQueryDto) {
    const from = query?.from;
    const to = query?.to;
    // YYYY-MM-DD satrlari leksikografik tartibda sana tartibiga teng.
    if (from && to && from > to) {
      throw new BadRequestException(
        'from sanasi to sanasidan keyin bo‘lishi mumkin emas',
      );
    }
    const data = await this.call(
      this.aiClient
        .send<unknown>(
          { cmd: 'ai.usage.summary' },
          { ...(from ? { from } : {}), ...(to ? { to } : {}) },
        )
        .pipe(timeout(RMQ_GATEWAY_TIMEOUT)),
    );
    return successRes(data);
  }

  /** RPC javobi; rxjs timeout → 504, boshqa xato o'zgarishsiz yuqoriga. */
  private async call<T>(source: Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(source);
    } catch (error: unknown) {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('AI service javob bermadi');
      }
      throw error;
    }
  }
}
