import {
  BadRequestException,
  Body,
  Controller,
  GatewayTimeoutException,
  Inject,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
import { Roles as RoleEnum } from '@app/common';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  PrintRow,
  renderReceiptHtml,
  renderThermalPdf,
} from './printer/printer.util';

class PrintOrdersDto {
  order_ids!: string[];
}

@ApiTags('Printer')
@ApiBearerAuth()
@Controller('printer')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(
  RoleEnum.ADMIN,
  RoleEnum.SUPERADMIN,
  RoleEnum.REGISTRATOR,
  RoleEnum.MANAGER,
  RoleEnum.BRANCH,
)
export class PrinterGatewayController {
  constructor(@Inject('ORDER') private readonly orderClient: ClientProxy) {}

  private async fetchPrintRows(orderIds: string[]): Promise<PrintRow[]> {
    const ids = Array.isArray(orderIds)
      ? orderIds.map((x) => String(x)).filter(Boolean)
      : [];
    if (!ids.length) {
      throw new BadRequestException('order_ids majburiy');
    }

    const res = await firstValueFrom(
      this.orderClient
        .send<{
          data: PrintRow[];
        }>({ cmd: 'order.print.find' }, { order_ids: ids })
        .pipe(timeout(12000)),
    ).catch((err) => {
      if (err instanceof TimeoutError) {
        throw new GatewayTimeoutException('order-service javob bermadi');
      }
      throw err;
    });

    const rows = res?.data ?? [];
    if (!rows.length) {
      throw new BadRequestException('Hech qanday buyurtma topilmadi');
    }
    return rows;
  }

  @Post('thermal-pdf')
  @ApiOperation({
    summary: 'Termal etiketka PDF (100×60mm, Gainscha GS-2408D)',
  })
  @ApiBody({ type: PrintOrdersDto })
  async thermalPdf(
    @Body() dto: PrintOrdersDto,
    @Res() res: Response,
  ): Promise<void> {
    const rows = await this.fetchPrintRows(dto?.order_ids);
    const pdf = await renderThermalPdf(rows);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="labels.pdf"',
      'Content-Length': String(pdf.length),
    });
    res.end(pdf);
  }

  @Post('receipt')
  @ApiOperation({ summary: 'A4 chek (12 ta/varaq), brauzerda avto-print' })
  @ApiBody({ type: PrintOrdersDto })
  async receipt(
    @Body() dto: PrintOrdersDto,
    @Res() res: Response,
  ): Promise<void> {
    const rows = await this.fetchPrintRows(dto?.order_ids);
    const html = await renderReceiptHtml(rows);
    res.set({ 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}
