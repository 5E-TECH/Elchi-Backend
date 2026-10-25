import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * FRONTEND XATOLARI JURNALI (QKCeGZ3N, 4-band). Ilova xato chegarasi (`ErrorBoundary`) sahifa yiqilganda xato kodini
 * shu yerga yuboradi — prod'da ham ko'rinsin (ilgari xato faqat brauzer konsolida edi). Bazaga YOZILMAYDI: gateway
 * jurnaliga bitta tuzilgan qator (`client_error`) — `docker logs api-gateway | grep client_error`.
 */
export class ClientErrorReportDto {
  @ApiProperty({
    example: 'ERR-7F3A',
    description: 'Qisqa xato kodi (foydalanuvchi ekranda ko‘radi).',
  })
  @IsString()
  @Matches(/^ERR-[0-9A-F]{4}$/)
  code!: string;

  @ApiProperty({ example: 'r.forEach is not a function' })
  @IsString()
  @MaxLength(500)
  message!: string;

  @ApiProperty({
    example: '/orders?status=waiting',
    description: 'Yiqilgan sahifa yo‘li.',
  })
  @IsString()
  @MaxLength(300)
  path!: string;

  @ApiPropertyOptional({
    description: 'Stek (minifikatsiyalangan bo‘lishi mumkin).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  stack?: string;

  @ApiPropertyOptional({ description: 'React komponentlar steki.' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  component_stack?: string;

  @ApiPropertyOptional({ description: 'Ilova versiyasi (build).' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  release?: string;

  @ApiPropertyOptional({ description: 'Bo‘lim yoki sahifa darajasi.' })
  @IsOptional()
  @IsString()
  @Matches(/^(page|section|app)$/)
  scope?: string;
}

type RequestUser = { sub?: string | number; roles?: string[]; role?: string };

@ApiTags('Client errors')
@Controller('client-errors')
export class ClientErrorGatewayController {
  private readonly logger = new Logger('ClientError');

  /**
   * Har qanday kirgan foydalanuvchi (global JWT guard). IP bo'yicha 10 / daqiqa — bitta sahifa takror yiqilsa ham
   * jurnal to'lib ketmaydi (frontend ham bir kodni sessiyada bir marta yuboradi).
   */
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Frontend runtime error report (QKCeGZ3N) — logged as a structured `client_error` line, not stored',
  })
  report(
    @Req() req: { user?: RequestUser; headers?: Record<string, unknown> },
    @Body() dto: ClientErrorReportDto,
  ): void {
    const roles = req?.user?.roles ?? (req?.user?.role ? [req.user.role] : []);
    const userAgent = req?.headers?.['user-agent'];
    this.logger.warn(
      JSON.stringify({
        type: 'client_error',
        code: dto.code,
        message: dto.message,
        path: dto.path,
        scope: dto.scope ?? 'page',
        release: dto.release ?? null,
        user_id: req?.user?.sub != null ? String(req.user.sub) : null,
        roles,
        user_agent:
          typeof userAgent === 'string' ? userAgent.slice(0, 300) : null,
        stack: dto.stack ?? null,
        component_stack: dto.component_stack ?? null,
      }),
    );
  }
}
