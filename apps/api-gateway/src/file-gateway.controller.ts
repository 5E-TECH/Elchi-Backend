import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
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

@ApiTags('File')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class FileGatewayController {
  private readonly allowedMime = new Set<string>([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]);

  constructor(@Inject('FILE') private readonly fileClient: ClientProxy) {}

  @Post('files/upload')
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
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
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
  @ApiOperation({ summary: 'Get signed URL for file key' })
  @ApiParam({ name: 'key', description: 'Object key in MinIO' })
  @ApiQuery({ name: 'expires_in', required: false, type: Number, example: 3600 })
  getFileUrl(
    @Param('key') key: string,
    @Query('expires_in', new ParseIntPipe({ optional: true })) expires_in?: number,
  ) {
    return this.fileClient.send({ cmd: 'file.get_url' }, { key, expires_in });
  }

  @Delete('files/:key')
  @ApiOperation({ summary: 'Delete file by key' })
  @ApiParam({ name: 'key', description: 'Object key in MinIO' })
  deleteFile(@Param('key') key: string) {
    return this.fileClient.send({ cmd: 'file.delete' }, { key });
  }

  @Post('files/qr')
  @ApiOperation({ summary: 'Generate QR and upload to MinIO' })
  @ApiBody({ type: GenerateQrRequestDto })
  generateQr(@Body() dto: GenerateQrRequestDto) {
    return this.fileClient.send({ cmd: 'file.generate_qr' }, dto);
  }

  @Post('files/pdf')
  @ApiOperation({ summary: 'Generate PDF and upload to MinIO' })
  @ApiBody({ type: GeneratePdfRequestDto })
  generatePdf(@Body() dto: GeneratePdfRequestDto) {
    return this.fileClient.send({ cmd: 'file.generate_pdf' }, dto);
  }
}
