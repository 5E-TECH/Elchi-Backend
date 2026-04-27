import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import { GeneratePdfDto } from './dto/generate-pdf.dto';
import { GenerateQrDto } from './dto/generate-qr.dto';
import { UploadFileDto } from './dto/upload-file.dto';
import { GetFileUrlDto } from './dto/get-file-url.dto';
import { DeleteFileDto } from './dto/delete-file.dto';

type UploadResult = {
  key: string;
  bucket: string;
  file_name: string;
  mime_type: string;
  size: number;
  url: string;
};

@Injectable()
export class FileServiceService implements OnModuleInit {
  private readonly logger = new Logger(FileServiceService.name);
  private readonly bucket: string;
  private readonly maxSizeBytes: number;
  private readonly defaultExpiresIn: number;
  private readonly allowedMime = new Set<string>([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]);
  private readonly s3: S3Client;

  constructor(private readonly configService: ConfigService) {
    const endpointHost = this.configService.getOrThrow<string>('MINIO_ENDPOINT');
    const port = Number(this.configService.get<string>('MINIO_PORT') ?? 9000);
    const useSsl = String(this.configService.get<string>('MINIO_USE_SSL') ?? 'false') === 'true';
    const accessKeyId = this.configService.getOrThrow<string>('MINIO_ACCESS_KEY');
    const secretAccessKey = this.configService.getOrThrow<string>('MINIO_SECRET_KEY');
    this.bucket = this.configService.get<string>('MINIO_BUCKET') ?? 'elchi-files';
    const maxMb = Number(this.configService.get<string>('FILE_MAX_SIZE_MB') ?? 10);
    this.maxSizeBytes = Math.max(1, maxMb) * 1024 * 1024;
    this.defaultExpiresIn = Number(this.configService.get<string>('FILE_SIGNED_URL_EXPIRES') ?? 3600);

    const endpoint = `${useSsl ? 'https' : 'http'}://${endpointHost}:${port}`;
    this.s3 = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async onModuleInit() {
    try {
      await this.ensureBucketExists();
    } catch (error) {
      this.logger.error('MinIO bucket init failed', error instanceof Error ? error.stack : undefined);
      throw error;
    }
  }

  private successRes<T>(data: T, code = 200, message = 'success') {
    return {
      statusCode: code,
      message,
      data,
    };
  }

  private toRpcError(error: unknown): never {
    if (error instanceof RpcException) {
      throw error;
    }

    if (error instanceof NotFoundException) {
      throw new RpcException({ statusCode: 404, message: error.message });
    }

    if (error instanceof BadRequestException) {
      throw new RpcException({ statusCode: 400, message: error.message });
    }

    throw new RpcException({
      statusCode: 500,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }

  private sanitizeName(name: string) {
    return String(name)
      .trim()
      .replace(/[^\w.-]/g, '_')
      .replace(/_+/g, '_');
  }

  private normalizeFolder(folder?: string): string {
    const fallback = 'uploads';
    if (!folder) return fallback;
    const cleaned = folder
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '');
    return cleaned || fallback;
  }

  private decodeBase64(value: string): Buffer {
    const cleaned = value.includes(',') ? value.split(',').pop() ?? '' : value;
    if (!cleaned) {
      throw new BadRequestException('file_base64 is required');
    }
    const buffer = Buffer.from(cleaned, 'base64');
    if (!buffer.length) {
      throw new BadRequestException('file_base64 is invalid');
    }
    return buffer;
  }

  private validateFile(mimeType: string, size: number) {
    if (!this.allowedMime.has(mimeType)) {
      throw new BadRequestException(
        'Unsupported mime type. Allowed: image/png, image/jpeg, image/jpg, application/pdf, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
    }

    if (size > this.maxSizeBytes) {
      throw new BadRequestException(`File size exceeds ${Math.round(this.maxSizeBytes / 1024 / 1024)}MB`);
    }
  }

  private async ensureBucketExists() {
    const buckets = await this.s3.send(new ListBucketsCommand({}));
    const exists = (buckets.Buckets ?? []).some((bucket) => bucket.Name === this.bucket);
    if (!exists) {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
      this.logger.log(`Created bucket: ${this.bucket}`);
    }
  }

  private async ensureObjectExists(key: string) {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch {
      throw new NotFoundException('File not found');
    }
  }

  private async uploadBuffer(params: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    folder?: string;
  }): Promise<UploadResult> {
    const folder = this.normalizeFolder(params.folder);
    const originalName = this.sanitizeName(params.fileName);
    const uniqueName = `${Date.now()}-${randomUUID()}-${originalName}`;
    const key = `${folder}-${uniqueName}`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: params.buffer,
        ContentType: params.mimeType,
      }),
    );

    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: this.defaultExpiresIn },
    );

    return {
      key,
      bucket: this.bucket,
      file_name: originalName,
      mime_type: params.mimeType,
      size: params.buffer.length,
      url,
    };
  }

  async upload(data: UploadFileDto) {
    try {
      const fileName = String(data?.file_name ?? '').trim();
      const mimeType = String(data?.mime_type ?? '').trim().toLowerCase();
      if (!fileName) throw new BadRequestException('file_name is required');
      if (!mimeType) throw new BadRequestException('mime_type is required');

      const buffer = this.decodeBase64(String(data?.file_base64 ?? ''));
      this.validateFile(mimeType, buffer.length);

      const result = await this.uploadBuffer({
        buffer,
        fileName,
        mimeType,
        folder: data?.folder,
      });

      return this.successRes(result, 201, 'File uploaded');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async getUrl(data: GetFileUrlDto) {
    try {
      const key = String(data?.key ?? '').trim();
      if (!key) throw new BadRequestException('key is required');

      await this.ensureObjectExists(key);

      const expiresIn = Number(data?.expires_in ?? this.defaultExpiresIn);
      const safeExpires = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : this.defaultExpiresIn;
      const url = await getSignedUrl(
        this.s3,
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
        { expiresIn: safeExpires },
      );

      return this.successRes(
        {
          key,
          bucket: this.bucket,
          expires_in: safeExpires,
          url,
        },
        200,
        'File URL generated',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async remove(data: DeleteFileDto) {
    try {
      const key = String(data?.key ?? '').trim();
      if (!key) throw new BadRequestException('key is required');
      await this.ensureObjectExists(key);

      await this.s3.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );

      return this.successRes({ key, bucket: this.bucket }, 200, 'File deleted');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async generateQr(data: GenerateQrDto) {
    try {
      const text = String(data?.text ?? '').trim();
      if (!text) throw new BadRequestException('text is required');
      const prefix = data?.prefix ? String(data.prefix) : '';
      const qrText = `${prefix}${text}`;

      const buffer = await QRCode.toBuffer(qrText, {
        type: 'png',
        width: 512,
        errorCorrectionLevel: 'M',
      });
      const result = await this.uploadBuffer({
        buffer,
        fileName: data?.file_name?.trim() || 'qr.png',
        mimeType: 'image/png',
        folder: data?.folder ?? 'qr',
      });

      return this.successRes(result, 201, 'QR generated and uploaded');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async generatePdf(data: GeneratePdfDto) {
    try {
      const content = String(data?.content ?? '').trim();
      const title = String(data?.title ?? 'Document').trim();
      if (!content) throw new BadRequestException('content is required');

      const buffer = await new Promise<Buffer>((resolve, reject) => {
        const doc = new PDFDocument({ size: 'A4', margin: 50 });
        const chunks: Buffer[] = [];
        doc.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        doc.on('error', reject);
        doc.on('end', () => resolve(Buffer.concat(chunks)));

        doc.fontSize(18).text(title, { align: 'left' });
        doc.moveDown();
        doc.fontSize(12).text(content, {
          align: 'left',
          lineGap: 4,
        });
        doc.end();
      });

      const result = await this.uploadBuffer({
        buffer,
        fileName: data?.file_name?.trim() || 'document.pdf',
        mimeType: 'application/pdf',
        folder: data?.folder ?? 'pdf',
      });

      return this.successRes(result, 201, 'PDF generated and uploaded');
    } catch (error) {
      this.toRpcError(error);
    }
  }
}
