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
  private readonly maxVideoSizeBytes: number;
  private readonly defaultExpiresIn: number;
  private readonly maxExpiresIn: number;
  private readonly allowedMime = new Set<string>([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    // Video proof (expense proof on order sell/cancel)
    'video/mp4',
    'video/quicktime',
    'video/webm',
  ]);
  private readonly videoMime = new Set<string>([
    'video/mp4',
    'video/quicktime',
    'video/webm',
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
    const maxVideoMb = Number(
      this.configService.get<string>('FILE_MAX_VIDEO_SIZE_MB') ?? 50,
    );
    this.maxVideoSizeBytes = Math.max(1, maxVideoMb) * 1024 * 1024;
    this.defaultExpiresIn = Number(this.configService.get<string>('FILE_SIGNED_URL_EXPIRES') ?? 3600);
    this.maxExpiresIn = Math.max(
      this.defaultExpiresIn,
      Number(this.configService.get<string>('FILE_SIGNED_URL_MAX_EXPIRES') ?? 86_400),
    );

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
        'Unsupported mime type. Allowed: image/png, image/jpeg, image/jpg, application/pdf, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, video/mp4, video/quicktime, video/webm',
      );
    }

    // Video proof files are allowed a larger ceiling than images/documents.
    const limit = this.videoMime.has(mimeType)
      ? this.maxVideoSizeBytes
      : this.maxSizeBytes;
    if (size > limit) {
      throw new BadRequestException(
        `File size exceeds ${Math.round(limit / 1024 / 1024)}MB`,
      );
    }
  }

  /**
   * Inspect the buffer's leading bytes (file signature / "magic number") and
   * confirm they match the claimed MIME type. Client-supplied mime_type alone
   * is untrusted — an attacker can label an .exe as image/jpeg and the
   * whitelist check above would pass.
   */
  private assertMagicBytesMatchMime(buffer: Buffer, mimeType: string): void {
    if (buffer.length < 4) {
      throw new BadRequestException('File content too small to validate');
    }

    // Compare an exact prefix against the buffer.
    const startsWith = (prefix: number[]): boolean =>
      prefix.every((byte, idx) => buffer[idx] === byte);

    // ISO Base Media (mp4/quicktime): bytes 4..7 spell "ftyp".
    const hasFtypBox =
      buffer.length >= 8 &&
      buffer[4] === 0x66 &&
      buffer[5] === 0x74 &&
      buffer[6] === 0x79 &&
      buffer[7] === 0x70;

    // detected → the set of mime types that signature legitimately covers.
    const detected = ((): { token: string; accepts: string[] } | null => {
      // PNG: 89 50 4E 47 0D 0A 1A 0A
      if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        return { token: 'image/png', accepts: ['image/png'] };
      // JPEG: FF D8 FF
      if (startsWith([0xff, 0xd8, 0xff]))
        return { token: 'image/jpeg', accepts: ['image/jpeg'] };
      // PDF: %PDF-
      if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d]))
        return { token: 'application/pdf', accepts: ['application/pdf'] };
      // ZIP (XLSX/DOCX/PPTX containers): PK\x03\x04
      if (startsWith([0x50, 0x4b, 0x03, 0x04])) {
        return {
          token: 'application/zip',
          accepts: [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ],
        };
      }
      // EBML (WebM / Matroska): 1A 45 DF A3
      if (startsWith([0x1a, 0x45, 0xdf, 0xa3]))
        return { token: 'video/webm', accepts: ['video/webm'] };
      // ISO BMFF "ftyp" box → mp4 / quicktime share the same container.
      if (hasFtypBox)
        return {
          token: 'video/mp4',
          accepts: ['video/mp4', 'video/quicktime'],
        };
      return null;
    })();

    if (!detected) {
      throw new BadRequestException(
        'File content does not match any allowed type (magic bytes unrecognised)',
      );
    }

    const normalizedClaimed = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;
    if (!detected.accepts.includes(normalizedClaimed)) {
      this.logger.warn(
        `MIME mismatch: client claimed "${mimeType}", buffer signature is "${detected.token}" — rejecting`,
      );
      throw new BadRequestException(
        `File content (${detected.token}) does not match declared mime_type (${mimeType})`,
      );
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
      this.assertMagicBytesMatchMime(buffer, mimeType);

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
      const bounded =
        Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : this.defaultExpiresIn;
      // Cap at maxExpiresIn so a client cannot request a multi-year link.
      const safeExpires = Math.min(bounded, this.maxExpiresIn);
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

  /**
   * Lightweight existence check (HEAD) — used by order-service to verify that
   * proof file keys submitted with an expense actually point to uploaded
   * objects, so a courier cannot satisfy the proof requirement with a made-up
   * key. Returns { exists: boolean } instead of throwing on a missing object.
   */
  async exists(data: { key?: string }) {
    try {
      const key = String(data?.key ?? '').trim();
      if (!key) throw new BadRequestException('key is required');
      try {
        await this.s3.send(
          new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        );
        return this.successRes({ key, exists: true }, 200, 'File exists');
      } catch {
        return this.successRes({ key, exists: false }, 200, 'File not found');
      }
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
