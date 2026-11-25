import {
  Body,
  Controller,
  HttpCode,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { XLSX_MIME } from '@app/report-kit';
import { Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { OldMailsExportRequestDto } from './dto/old-mails-export.swagger.dto';
import {
  buildOldMailsXlsx,
  oldMailsXlsxFileName,
} from './order-export/old-mails-xlsx';

/**
 * «Eski pochtalar» sahifasini ko'radigan rollar (FE `canViewMails`:
 * superadmin, admin, registrator, manager, courier). LOGIST yo'q — faylda summa
 * bor.
 */
export const OLD_MAILS_EXPORT_ROLES = [
  RoleEnum.SUPERADMIN,
  RoleEnum.ADMIN,
  RoleEnum.REGISTRATOR,
  RoleEnum.MANAGER,
  RoleEnum.COURIER,
];

@ApiTags('Excel Export')
@ApiBearerAuth()
@Controller('export')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OldMailsExportController {
  @Post('old-mails.xlsx')
  @HttpCode(200)
  @Roles(...OLD_MAILS_EXPORT_ROLES)
  @ApiOperation({
    summary: 'Eski pochtalar hisoboti — .xlsx (sof render)',
    description:
      "Qatorlarni sahifa o'zi yuboradi (`GET /post` / `post/courier/old-posts` / `transfer-batches` dan yig'ilgan), server faqat Excel qiladi — bazadan o'qimaydi. " +
      'Chegara: 10 000 qator, tana ≤ 4 MB (katta bo‘lsa 413). Ortig‘i bo‘lsa — birinchi 10 000 qator va `capped: true`. ' +
      '`hide_courier: true` — «Filial paketlari» rejimi. Fayl: `old-mails-<YYYY-MM-DD>.xlsx` (Toshkent kuni).',
  })
  @ApiProduces(XLSX_MIME)
  @ApiOkResponse({ description: XLSX_MIME })
  async exportOldMails(
    @Body() dto: OldMailsExportRequestDto,
    @Res() res: Response,
  ): Promise<void> {
    const now = new Date();
    const buffer = await buildOldMailsXlsx(dto, now);
    res.set({
      'Content-Type': XLSX_MIME,
      'Content-Disposition': `attachment; filename="${oldMailsXlsxFileName(now)}"`,
      'Content-Length': String(buffer.length),
      'Cache-Control': 'no-store',
    });
    res.end(buffer);
  }
}
