import { BadRequestException, GatewayTimeoutException } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { fileOwnerOf } from './file-ownership';

/**
 * Sotuv / qisman sotuv / bekor qilish isboti (multipart `proof`) — umumiy
 * yordamchi. Kuryer marshrutlari (`/orders/sell|partly-sell|cancel`) va
 * Carrier API (`/carrier/orders/:id/status`) AYNI yo'ldan yuklaydi: fayl
 * `file.upload` orqali `proof` papkasiga, egasi — amalni bajargan kurier.
 */
export type UploadedProofFile = {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
};

/** Isbot yuklanadigan amallar uchun RMQ kutish vaqti (fayl katta bo'lishi mumkin). */
export const PROOF_OPERATION_TIMEOUT_MS = 60000;

/** Isbot yuklovchi (fayl egasi sifatida yoziladi). */
export type ProofUploader = {
  sub?: string | number;
  roles?: string[];
  branch_id?: string | number | null;
};

const asStr = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  return '';
};

/** `proofFileKeys`: massiv, JSON-massiv satri yoki "k1,k2" — hammasi qabul. */
export function normalizeProofFileKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => normalizeProofFileKeys(item))
      .filter(Boolean);
  }
  if (typeof value !== 'string') return [];

  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return normalizeProofFileKeys(parsed);
  } catch {
    // Keep plain form-data values such as "key1,key2" supported.
  }
  return trimmed
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

export async function uploadProofFile(
  fileClient: ClientProxy | undefined,
  file: UploadedProofFile | undefined,
  uploader: ProofUploader,
): Promise<string[]> {
  if (!file) return [];
  if (!fileClient) {
    throw new BadRequestException('Fayl xizmati sozlanmagan');
  }

  const response = await firstValueFrom(
    fileClient
      .send(
        { cmd: 'file.upload' },
        {
          file_name: file.originalname,
          mime_type: file.mimetype,
          file_base64: file.buffer.toString('base64'),
          folder: 'proof',
          owner: fileOwnerOf(uploader),
        },
      )
      .pipe(timeout(PROOF_OPERATION_TIMEOUT_MS)),
  ).catch((error: unknown) => {
    if (error instanceof TimeoutError) {
      throw new GatewayTimeoutException(
        'Fayl xizmati vaqtida javob bermadi (timeout)',
      );
    }
    throw error;
  });

  const key = asStr(
    (response as { data?: { key?: unknown }; key?: unknown })?.data?.key ??
      (response as { key?: unknown })?.key,
  ).trim();
  if (!key) {
    throw new BadRequestException(
      "Isbot faylini yuklab bo'lmadi (kalit qaytmadi)",
    );
  }
  return [key];
}

/**
 * DTO'ga yuklangan isbot kalitini qo'shadi. `proofFileKeysVerified` faqat
 * fayl SHU so'rovda yuklangan va tashqi kalit berilmagan bo'lsa `true` —
 * aks holda order-service kalitlarni `file.exists` bilan tekshiradi.
 */
export async function withUploadedProof<
  T extends { proofFileKeys?: string[]; proofFileKeysVerified?: boolean },
>(
  fileClient: ClientProxy | undefined,
  dto: T,
  file: UploadedProofFile | undefined,
  uploader: ProofUploader,
): Promise<T> {
  const existingKeys = normalizeProofFileKeys(dto?.proofFileKeys);
  const uploadedKeys = await uploadProofFile(fileClient, file, uploader);
  return {
    ...dto,
    proofFileKeys: Array.from(new Set([...existingKeys, ...uploadedKeys])),
    proofFileKeysVerified: uploadedKeys.length > 0 && existingKeys.length === 0,
  };
}
