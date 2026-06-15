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
import { GeneratePdfRequestDto, GenerateQrRequestDto } from './dto/file.swagger.dto';
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
    @UploadedFile() file: {
      originalname: string;
      mimetype: string;
      buffer: Buffer;
    } | undefined,
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
          folder: typeof req?.body?.folder === 'string' ? req.body.folder : undefined,
        },
      ),
    );
  }

  @Get('files/:key')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get signed URL for file key' })
  @ApiParam({ name: 'key', description: 'Object key in MinIO' })
  @ApiQuery({ name: 'expires_in', required: false, type: Number, example: 3600 })
  getFileUrl(
    @Param('key') key: string,
    @Query('expires_in', new ParseIntPipe({ optional: true })) expires_in?: number,
  ) {
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

  @Get('files/view/:key')
  @ApiOperation({ summary: 'Public view for whitelisted (catalog/batch) images' })
  @ApiParam({ name: 'key', description: 'Object key in MinIO' })
  async viewFile(
    @Param('key') key: string,
    @Res() res: Response,
  ) {
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
      this.fileClient.send<{ data?: { body_base64?: string; mime_type?: string } }>(
        { cmd: 'file.read' },
        { key },
      ),
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

  @Delete('files/:key')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Delete file by key' })
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
