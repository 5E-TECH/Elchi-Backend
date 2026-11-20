import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  GatewayTimeoutException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { BranchType, Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { BranchTelegramReportTargetRequestDto } from './dto/notification.swagger.dto';

interface AuthedRequest {
  user?: { sub?: string; roles?: string[] };
  ip?: string;
}

interface BranchRow {
  id?: unknown;
  name?: unknown;
  type?: unknown;
}

const PATTERNS = {
  linkCode: 'notification.telegram.branch_link_code',
  status: 'notification.telegram.branch_status',
  reportTarget: 'notification.telegram.branch_report_target',
  unlink: 'notification.telegram.branch_unlink',
} as const;

const text = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/**
 * Filial kassasi Telegram guruhi: kassa (smena) yopilganda hisobot filial
 * guruhiga yoki — `report_target = 'private'` — filial menejerlarining
 * shaxsiy chatiga boradi.
 *
 * Huquq: superadmin / admin — istalgan filial; menejer — faqat O'Z filiali
 * (`branch_users`). HQ filiali (asosiy kassa) — o'zgartirish faqat
 * superadmin. Filial id — URL'dan, so'rovchi — JWT'dan.
 */
@ApiTags('Telegram')
@Controller('branches/:id/telegram')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
@ApiBearerAuth()
export class BranchTelegramGatewayController {
  constructor(
    @Inject('NOTIFICATION') private readonly notificationClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
  ) {}

  @Get()
  @ApiParam({ name: 'id', description: 'Filial ID' })
  @ApiOperation({
    summary: 'Filial kassasi Telegram guruhi holati',
    description:
      "`{ branch_id, report_target: 'group' | 'private', group: null | { chat_id, title, is_active, inactive_reason, inactive_at, linked_at, linked_by }, can_manage }`. `group: null` — ulanmagan (yoki panelda uzilgan). Menejer — faqat o'z filiali (boshqasi 403).",
  })
  async status(@Param('id') id: string, @Req() req: AuthedRequest) {
    const { branch, canManage } = await this.access(id, req, 'read');
    const response = await this.send<{ data?: Record<string, unknown> }>(
      this.notificationClient,
      { cmd: PATTERNS.status },
      { branch_id: text(branch.id) },
    );
    return {
      statusCode: 200,
      message: 'Branch Telegram',
      data: { ...(response?.data ?? {}), can_manage: canManage },
    };
  }

  @Post('link-code')
  @ApiParam({ name: 'id', description: 'Filial ID' })
  @ApiOperation({
    summary: 'Filial guruhini ulash havolasi (bir martalik, 10 daqiqa)',
    description:
      "Javob: `{ token, purpose: 'branch_group', branch_id, expires_at, deep_link (t.me/<bot>?startgroup=…), command }`. Guruhni tanlab botni qo'shish kifoya — bot o'zi ulaydi. Guruh allaqachon ulangan bo'lsa, yangi guruh uni almashtiradi. Market guruhini filialga ulab bo'lmaydi.",
  })
  async linkCode(@Param('id') id: string, @Req() req: AuthedRequest) {
    const { branch, requester } = await this.access(id, req, 'write');
    return this.send(
      this.notificationClient,
      { cmd: PATTERNS.linkCode },
      {
        branch_id: text(branch.id),
        branch_name: text(branch.name).slice(0, 120) || null,
        requester,
        ip: req.ip ?? null,
      },
    );
  }

  @Patch('report-target')
  @ApiParam({ name: 'id', description: 'Filial ID' })
  @ApiBody({ type: BranchTelegramReportTargetRequestDto })
  @ApiOperation({
    summary: 'Kassa hisoboti qayerga: guruhga yoki shaxsiy chatga',
    description:
      "`group` (sukut) — filial guruhiga; `private` — filial menejerlarining shaxsiy Telegram chatiga (bot orqali; menejer Telegram'ga ulangan bo'lishi kerak). Guruh ulanmagan bo'lsa ham `private` tanlash mumkin.",
  })
  async reportTarget(
    @Param('id') id: string,
    @Body() dto: BranchTelegramReportTargetRequestDto,
    @Req() req: AuthedRequest,
  ) {
    const { branch, requester } = await this.access(id, req, 'write');
    return this.send(
      this.notificationClient,
      { cmd: PATTERNS.reportTarget },
      {
        branch_id: text(branch.id),
        report_target: dto.report_target,
        requester,
      },
    );
  }

  @Delete('group')
  @ApiParam({ name: 'id', description: 'Filial ID' })
  @ApiOperation({
    summary: 'Filial guruhini uzish',
    description:
      "Guruhga hisobot boshqa bormaydi (bot guruhda qoladi — kerak bo'lsa guruhdan o'zingiz chiqaring). Qayta ulash — yangi havola bilan.",
  })
  async unlink(@Param('id') id: string, @Req() req: AuthedRequest) {
    const { branch, requester } = await this.access(id, req, 'write');
    return this.send(
      this.notificationClient,
      { cmd: PATTERNS.unlink },
      { branch_id: text(branch.id), requester },
    );
  }

  // ───────────────────────── huquq ─────────────────────────

  /**
   * Filial mavjud va so'rovchi unga kira oladimi. `write` — HQ filiali faqat
   * superadmin. Menejer — `branch_users` dagi o'z filiali (ajdod / bola
   * filiallar emas).
   */
  private async access(
    rawId: string,
    req: AuthedRequest,
    mode: 'read' | 'write',
  ): Promise<{
    branch: BranchRow;
    requester: { id: string; roles: string[] };
    canManage: boolean;
  }> {
    const requester = this.requester(req);
    const id = String(rawId ?? '').trim();
    if (!/^\d{1,19}$/.test(id) || /^0+$/.test(id)) {
      throw new NotFoundException('Filial topilmadi');
    }
    const roles = requester.roles.map((role) => role.toLowerCase());
    const isSuper = roles.includes(RoleEnum.SUPERADMIN);
    const isAdmin = isSuper || roles.includes(RoleEnum.ADMIN);
    if (!isAdmin) {
      const assignment = await this.send<{ data?: { branch_id?: unknown } }>(
        this.branchClient,
        { cmd: 'branch.user.find_by_user' },
        { user_id: requester.id, requester },
      );
      if (text(assignment?.data?.branch_id) !== id) {
        throw new ForbiddenException(
          "Faqat o'z filialingiz Telegram guruhini boshqara olasiz",
        );
      }
    }
    const response = await this.send<{ data?: BranchRow | null }>(
      this.branchClient,
      { cmd: 'branch.find_by_id' },
      { id, requester },
    );
    const branch = response?.data;
    if (!branch || text(branch.id) !== id) {
      throw new NotFoundException('Filial topilmadi');
    }
    const isHq = text(branch.type).toUpperCase() === String(BranchType.HQ);
    const canManage = isHq ? isSuper : true;
    if (mode === 'write' && !canManage) {
      throw new ForbiddenException(
        'Asosiy kassa (HQ) Telegram guruhini faqat superadmin boshqaradi',
      );
    }
    return { branch, requester, canManage };
  }

  private requester(req: AuthedRequest): { id: string; roles: string[] } {
    const id = req.user?.sub;
    if (!id) {
      throw new UnauthorizedException(
        "Foydalanuvchi autentifikatsiyadan o'tmagan",
      );
    }
    return { id: String(id), roles: req.user?.roles ?? [] };
  }

  private send<T = unknown>(
    client: ClientProxy,
    pattern: object,
    payload: object,
  ): Promise<T> {
    return firstValueFrom(
      client.send<T>(pattern, payload).pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException(
          'Xizmat vaqtida javob bermadi (timeout)',
        );
      }
      throw error;
    });
  }
}
