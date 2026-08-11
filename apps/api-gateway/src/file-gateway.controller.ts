import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Public } from './auth/public.decorator';
import { RolesGuard } from './auth/roles.guard';
import { Roles } from './auth/roles.decorator';
import { Roles as RoleEnum } from '@app/common';
import {
  GeneratePdfRequestDto,
  GenerateQrRequestDto,
} from './dto/file.swagger.dto';
import type { Response } from 'express';

@ApiTags('File')
@ApiBearerAuth()
@Controller()
export class FileGatewayController {
  private readonly allowedMime = new Set<string>([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'video/mp4',
    'video/quicktime',
    'video/webm',
  ]);

  constructor(@Inject('FILE') private readonly fileClient: ClientProxy) {}

  @Post('files/upload')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Upload file to MinIO (multipart/form-data)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        folder: { type: 'string', example: 'uploads' },
      },
      required: ['file'],
    },
  })
  @UseInterceptors(
    // 50MB ceiling to allow video expense-proof uploads. file-service still
    // enforces the real per-type limit (10MB image/doc, 50MB video).
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async uploadFile(
    @UploadedFile()
    file:
      | {
          originalname: string;
          mimetype: string;
          buffer: Buffer;
        }
      | undefined,
    @Req() req: { body?: Record<string, unknown> },
  ) {
    if (!file) {
      throw new BadRequestException('file is required');
    }

    if (!this.allowedMime.has(file.mimetype)) {
      throw new BadRequestException('Unsupported file type');
    }

    return firstValueFrom(
      this.fileClient.send(
        { cmd: 'file.upload' },
        {
          file_name: file.originalname,
          mime_type: file.mimetype,
          file_base64: file.buffer.toString('base64'),
          folder:
            typeof req?.body?.folder === 'string' ? req.body.folder : undefined,
        },
      ),
    );
  }

  // Sensitive object-key prefixes: COD-evidence, expense/return proof, receipts.
  // A signed URL for one of these is a bearer capability over *financial
  // evidence*, so minting it requires a staff/business role — not merely any
  // logged-in account. This narrows the previous "any authenticated user → any
  // file" object-level IDOR on GET/DELETE (Audit P1). The lowest-trust read-only
  // roles (customer, investor) are denied outright. NOTE: full per-object
  // ownership ("only the uploader/assignee") still needs a file-ownership
  // registry in file-service — tracked as a follow-up; this closes the
  // cross-role leak and the destructive delete, which are the exploitable parts.
  private static readonly PRIVATE_KEY_PREFIXES = [
    'proof-',
    'expense-',
    'return-',
    'cod-',
    'receipt-',
  ];

  private static readonly PRIVATE_FILE_ROLES = new Set<string>([
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.OPERATOR,
    RoleEnum.MARKET_OPERATOR,
    RoleEnum.BRANCH,
    RoleEnum.MARKET,
    RoleEnum.COURIER,
  ]);

  private rolesOf(req: { user?: { roles?: string[] } }): string[] {
    return (req?.user?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
  }

  private assertCanAccessPrivateKey(key: string, roles: string[]): void {
    const safeKey = String(key ?? '');
    const isPrivate = FileGatewayController.PRIVATE_KEY_PREFIXES.some(
      (prefix) => safeKey.startsWith(prefix),
    );
    if (!isPrivate) {
      return;
    }
    const allowed = roles.some((role) =>
      FileGatewayController.PRIVATE_FILE_ROLES.has(role),
    );
    if (!allowed) {
      throw new ForbiddenException(
        'Bu maxfiy faylga (moliyaviy dalil) kirish uchun ruxsatingiz yetarli emas',
      );
    }
  }

  @Get('files/:key')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get signed URL for file key' })
  @ApiParam({ name: 'key', description: 'Object key in MinIO' })
  @ApiQuery({
    name: 'expires_in',
    required: false,
    type: Number,
    example: 3600,
  })
  getFileUrl(
    @Param('key') key: string,
    @Req() req: { user?: { roles?: string[] } },
    @Query('expires_in', new ParseIntPipe({ optional: true }))
    expires_in?: number,
  ) {
    this.assertCanAccessPrivateKey(key, this.rolesOf(req));
    return this.fileClient.send({ cmd: 'file.get_url' }, { key, expires_in });
  }

  // Object-key prefixes that may be served UNAUTHENTICATED (so plain <img src>
  // works): public catalog images and operational batch photos only. Everything
  // else — expense-proof / COD-evidence / ad-hoc uploads — is private and must
  // go through the authenticated signed-URL route (GET files/:key). (Audit P1-7.)
  private static readonly PUBLIC_VIEW_PREFIXES = [
    'products-',
    'branch-transfer-batches-',
  ];

  @Public()
  @Get('files/view/:key')
  @ApiOperation({
    summary: 'Public view for whitelisted (catalog/batch) images',
  })
  @ApiParam({ name: 'key', description: 'Object key in MinIO' })
  async viewFile(@Param('key') key: string, @Res() res: Response) {
    const safeKey = String(key ?? '');
    const isPublic = FileGatewayController.PUBLIC_VIEW_PREFIXES.some((prefix) =>
      safeKey.startsWith(prefix),
    );
    if (!isPublic) {
      throw new ForbiddenException(
        'Bu fayl ochiq ko‘rishga ruxsat etilmagan; autentifikatsiyalangan imzolangan URL ishlating',
      );
    }
    const response = await firstValueFrom(
      this.fileClient.send<{
        data?: { body_base64?: string; mime_type?: string };
      }>({ cmd: 'file.read' }, { key }),
    );

    const bodyBase64 = response?.data?.body_base64;
    const mimeType = response?.data?.mime_type ?? 'application/octet-stream';
    if (!bodyBase64 || typeof bodyBase64 !== 'string') {
      throw new BadRequestException('File read failed');
    }

    const buffer = Buffer.from(bodyBase64, 'base64');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(buffer);
  }

  // Deleting a stored object is a destructive, irreversible operation over
  // shared storage (product images, COD-evidence, expense proof). It is an
  // administrative action, so it is restricted to SUPERADMIN/ADMIN rather than
  // any authenticated user (Audit P1: previously any logged-in account could
  // delete ANY file by key).
  @Delete('files/:key')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete file by key (admin only)' })
  @ApiParam({ name: 'key', description: 'Object key in MinIO' })
  deleteFile(@Param('key') key: string) {
    return this.fileClient.send({ cmd: 'file.delete' }, { key });
  }

  @Post('files/qr')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Generate QR and upload to MinIO' })
  @ApiBody({ type: GenerateQrRequestDto })
  generateQr(@Body() dto: GenerateQrRequestDto) {
    return this.fileClient.send({ cmd: 'file.generate_qr' }, dto);
  }

  @Post('files/pdf')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Generate PDF and upload to MinIO' })
  @ApiBody({ type: GeneratePdfRequestDto })
  generatePdf(@Body() dto: GeneratePdfRequestDto) {
    return this.fileClient.send({ cmd: 'file.generate_pdf' }, dto);
  }
}
