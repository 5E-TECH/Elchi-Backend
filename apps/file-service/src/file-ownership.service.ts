import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FileObject } from './entities/file-object.entity';

/** Yuklovchi — `file.upload` to'lovidagi ixtiyoriy `owner`. */
export interface FileOwnerInput {
  id?: string | number | null;
  role?: string | null;
  branch_id?: string | number | null;
}

const text = (
  value: string | number | null | undefined,
  max: number,
): string | null => {
  const clean = String(value ?? '').trim();
  return clean ? clean.slice(0, max) : null;
};

/**
 * (dgvwZasd B) Egalik reestri (`file_objects`).
 *
 * `record` / `forget` HECH QACHON throw qilmaydi: reestr yozuvi yiqilsa
 * yuklash (kuryer sotuvi, smena rasmi) to'xtamaydi — qatorsiz fayl eski
 * qoida bilan ishlaydi, ya'ni holat shu o'zgarishdan oldingidek. `find` esa
 * xatoni qaytaradi: "topilmadi" va "tekshirib bo'lmadi" farq qiladi (gateway
 * ikkinchisida eski qoidaga tushmaydi).
 */
@Injectable()
export class FileOwnershipService {
  private readonly logger = new Logger(FileOwnershipService.name);

  constructor(
    @InjectRepository(FileObject)
    private readonly repo: Pick<
      Repository<FileObject>,
      'insert' | 'findOneBy' | 'delete'
    >,
  ) {}

  async record(input: {
    key: string;
    folder: string;
    owner?: FileOwnerInput | null;
    mimeType: string;
    size: number;
  }): Promise<void> {
    const ownerId = text(input.owner?.id, 64);
    if (!ownerId) return;
    try {
      await this.repo.insert({
        key: input.key,
        folder: input.folder.slice(0, 64),
        owner_id: ownerId,
        owner_role: text(input.owner?.role, 32),
        owner_branch_id: text(input.owner?.branch_id, 32),
        mime_type: input.mimeType.slice(0, 128),
        size_bytes: input.size,
      });
    } catch (error) {
      this.logger.error(
        `Egalik yozilmadi (fayl eski qoida bilan ishlaydi): ${input.key}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  find(key: string): Promise<FileObject | null> {
    return this.repo.findOneBy({ key });
  }

  async forget(key: string): Promise<void> {
    try {
      await this.repo.delete({ key });
    } catch (error) {
      this.logger.warn(
        `Reestr qatori o'chirilmadi: ${key}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
