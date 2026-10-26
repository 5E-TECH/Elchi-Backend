import {
  BadRequestException,
  ForbiddenException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Roles as RoleEnum } from '@app/common';

/**
 * (dgvwZasd A) Umumiy `POST files/upload` — rol → papka oq ro'yxati va limit.
 *
 * ILGARI: istalgan rol (mijoz ham) 50 MB faylni xotiraga, istalgan `folder`
 * ga — jumladan ommaviy `products` ga (kalit `products-…` →
 * `GET files/view/:key` orqali autentifikatsiyasiz ochiladi) yuklay olardi.
 *
 * ENDI: papka faqat shu ro'yxatdan; har papkaga faqat ko'rsatilgan rollar.
 * Maxsus oqimlar (mahsulot rasmi — catalog, smena surati — finance, isbot
 * `proof` maydoni — order) o'z endpoint'larida papkani server tomonda
 * qo'yadi va bu siyosatga bog'liq emas.
 *
 * Jonli mijozlar (2026-10-26 tekshirildi):
 *  - Elchi-Frontend `uploadProofFile` — `folder=proof`, kuryer/menejer
 *    (sotish / qisman sotish / bekor qilish), FE limiti 10 MB;
 *  - Telegram bot `CourierService.uploadProof` — `folder=proof`, kuryer JWT,
 *    rasm ≤ 5 MB, video/hujjat ≤ 20 MB (Telegram `getFile` chegarasi).
 */

const MB = 1024 * 1024;

/** Rasm / PDF / XLSX uchun limit. */
export const UPLOAD_MAX_FILE_BYTES = 10 * MB;
/**
 * Video uchun limit — bot orqali kuryer isbot videosi 20 MB gacha keladi
 * (Telegram `getFile` bundan kattasini bermaydi). Avvalgi 50 MB dan kichik.
 */
export const UPLOAD_MAX_VIDEO_BYTES = 20 * MB;
/** Multer xotira chegarasi — eng katta ruxsat (video). */
export const UPLOAD_MULTER_MAX_BYTES = UPLOAD_MAX_VIDEO_BYTES;

const VIDEO_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const IMAGE_MIME = ['image/png', 'image/jpeg', 'image/jpg'] as const;

/** `folder` berilmasa — file-service bilan bir xil sukut. */
export const DEFAULT_UPLOAD_FOLDER = 'uploads';

interface FolderPolicy {
  roles: readonly RoleEnum[];
  /** Berilsa — faqat shu turlar (masalan ommaviy papkaga faqat rasm). */
  mimes?: readonly string[];
  description: string;
}

export const UPLOAD_FOLDER_POLICY: Readonly<Record<string, FolderPolicy>> = {
  proof: {
    roles: [
      RoleEnum.SUPERADMIN,
      RoleEnum.ADMIN,
      RoleEnum.MANAGER,
      RoleEnum.COURIER,
    ],
    description: 'buyurtma isboti (maxfiy `proof-` kaliti)',
  },
  uploads: {
    roles: [RoleEnum.SUPERADMIN, RoleEnum.ADMIN],
    description: '`folder` berilmaganda (sukut)',
  },
  products: {
    roles: [RoleEnum.SUPERADMIN, RoleEnum.ADMIN],
    mimes: IMAGE_MIME,
    description: 'ommaviy katalog rasmi (`products-` kaliti ochiq ko‘rinadi)',
  },
};

export const UPLOAD_FOLDERS = Object.keys(UPLOAD_FOLDER_POLICY);

/** Route darajasidagi `@Roles` — kamida bitta papkaga ruxsati bor rollar. */
export const UPLOAD_ROLES: RoleEnum[] = Array.from(
  new Set(Object.values(UPLOAD_FOLDER_POLICY).flatMap((p) => p.roles)),
);

/**
 * file-service `normalizeFolder` bilan bir xil tozalash + kichik harf: kalit
 * prefiksi (`proof-`, `products-`) maxfiy/ommaviy qoidalarga AYNAN mos
 * kelsin (`Proof` → `Proof-…` kaliti maxfiy prefiksdan chetda qolmasin).
 */
export function canonicalUploadFolder(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_UPLOAD_FOLDER;
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .toLowerCase();
  return cleaned || DEFAULT_UPLOAD_FOLDER;
}

export function uploadLimitFor(mimeType: string): number {
  return VIDEO_MIME.has(String(mimeType ?? '').toLowerCase())
    ? UPLOAD_MAX_VIDEO_BYTES
    : UPLOAD_MAX_FILE_BYTES;
}

/** 403 — papka ro'yxatda yo'q yoki rolga ruxsat etilmagan. */
export function assertFolderAllowed(folder: string, roles: string[]): void {
  const policy = UPLOAD_FOLDER_POLICY[folder];
  if (!policy) {
    throw new ForbiddenException(
      `"${folder}" papkasiga yuklash mumkin emas. Ruxsat etilgan papkalar: ${UPLOAD_FOLDERS.join(', ')}`,
    );
  }
  const allowed = roles.some((role) =>
    (policy.roles as readonly string[]).includes(role),
  );
  if (!allowed) {
    throw new ForbiddenException(
      `"${folder}" papkasiga yuklashga ruxsatingiz yo'q`,
    );
  }
}

/** 400 — papkaga mos bo'lmagan tur; 413 — tur bo'yicha limitdan katta. */
export function assertUploadFits(
  folder: string,
  mimeType: string,
  size: number,
): void {
  const policy = UPLOAD_FOLDER_POLICY[folder];
  if (policy?.mimes && !policy.mimes.includes(mimeType)) {
    throw new BadRequestException(
      `"${folder}" papkasiga faqat ${policy.mimes.join(', ')} yuklanadi`,
    );
  }
  const limit = uploadLimitFor(mimeType);
  if (size > limit) {
    throw new PayloadTooLargeException(
      `Fayl hajmi ${Math.round(limit / MB)} MB dan oshmasin`,
    );
  }
}

/** Swagger tavsifi — limitlar va papka/rol jadvali (kod bilan bir manbadan). */
export function uploadPolicySwaggerDescription(): string {
  const rows = UPLOAD_FOLDERS.map((folder) => {
    const p = UPLOAD_FOLDER_POLICY[folder];
    const mimes = p.mimes ? `; faqat ${p.mimes.join(', ')}` : '';
    return `- \`${folder}\` — ${p.roles.join(', ')} (${p.description}${mimes})`;
  });
  return [
    `Limit: rasm/PDF/XLSX ≤ ${UPLOAD_MAX_FILE_BYTES / MB} MB, video (mp4/mov/webm) ≤ ${UPLOAD_MAX_VIDEO_BYTES / MB} MB — oshsa 413.`,
    `Papka (\`folder\`) — oq ro'yxat; berilmasa \`${DEFAULT_UPLOAD_FOLDER}\`. Ro'yxatda yo'q papka yoki rolga ruxsat etilmagan papka — 403:`,
    ...rows,
  ].join('\n');
}
