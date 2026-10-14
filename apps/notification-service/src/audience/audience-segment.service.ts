import { BadRequestException, Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { successRes } from '../../../../libs/common/helpers/response';
import { NotificationAudienceSegment } from './audience-segment.entity';
import { AudiencePreviewService } from './audience-preview.service';
import {
  AudienceTargetInput,
  SEGMENT_KEYS,
  buildAudienceTarget,
  primitiveText,
} from './audience-request';

const ID_RE = /^\d{1,19}$/;

export interface CreateAudienceSegmentInput extends AudienceTargetInput {
  name?: unknown;
  description?: unknown;
  requester?: { id?: string | number | null } | null;
}

/** Faqat nishon SHARTI saqlanadi — aniq id'lar, telefon, ism EMAS. */
function cleanAudience(input: AudienceTargetInput): AudienceTargetInput {
  const segment = input.segment
    ? Object.fromEntries(
        SEGMENT_KEYS.filter(
          (key) =>
            input.segment?.[key] !== undefined &&
            input.segment?.[key] !== null &&
            input.segment?.[key] !== '',
        ).map((key) => [key, input.segment?.[key]]),
      )
    : undefined;
  return {
    ...(input.roles?.length ? { roles: [...input.roles] } : {}),
    ...(input.broadcast === true ? { broadcast: true } : {}),
    ...(input.include_customers === true ? { include_customers: true } : {}),
    ...(input.confirm_all_customers === true
      ? { confirm_all_customers: true }
      : {}),
    ...(segment && Object.keys(segment).length ? { segment } : {}),
  };
}

const rpc = (statusCode: number, message: string) =>
  new RpcException({ statusCode, message });

/**
 * Saqlangan auditoriya segmentlari (ebSV5oyP #7): nom bilan saqlash va
 * keyingi kampaniyada qayta ishlatish. Son har safar JONLI — preview
 * (`audience_segment_id`) va yuborish bir xil `identity.audience.resolve`
 * dan sanaydi, shuning uchun saqlangan segment qayta yuklanganda (ma'lumot
 * o'zgarmagan bo'lsa) aynan o'sha sonni beradi.
 */
@Injectable()
export class AudienceSegmentService {
  constructor(
    @InjectRepository(NotificationAudienceSegment)
    private readonly repo: Repository<NotificationAudienceSegment>,
    private readonly preview: AudiencePreviewService,
  ) {}

  async list() {
    const rows = await this.repo.find({
      where: { isDeleted: false },
      order: { name: 'ASC', id: 'ASC' },
    });
    return successRes(
      { items: rows.map((row) => this.toPublic(row)) },
      200,
      'Audience segments',
    );
  }

  async create(input: CreateAudienceSegmentInput) {
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 120) throw rpc(400, 'name: 1-120 belgi');
    const description =
      typeof input?.description === 'string' && input.description.trim()
        ? input.description.trim().slice(0, 500)
        : null;
    const audience = cleanAudience(input ?? {});
    let target;
    try {
      // Mijoz qoidalari (segment / confirm_all_customers) dispatch bilan bir xil.
      target = buildAudienceTarget(audience);
    } catch (error) {
      if (error instanceof BadRequestException) throw rpc(400, error.message);
      throw error;
    }
    if (!target)
      throw rpc(
        400,
        'Segment uchun kamida bitta filtr kerak: roles, broadcast yoki include_customers (+segment)',
      );
    const existing = await this.repo
      .createQueryBuilder('s')
      .where('LOWER(s.name) = LOWER(:name)', { name })
      .andWhere('s.isDeleted = false')
      .getOne();
    if (existing) throw rpc(409, `"${name}" nomli segment allaqachon bor`);

    // Saqlash paytidagi jonli son (identity xatosi — 4xx/5xx sifatida qaytadi).
    const counted = (await this.preview.preview(audience)) as {
      data?: { total?: number };
    };
    const requester = input?.requester?.id;
    try {
      const saved = await this.repo.save(
        this.repo.create({
          name,
          description,
          audience,
          last_total: Number(counted?.data?.total ?? 0),
          last_counted_at: new Date(),
          created_by:
            requester !== undefined &&
            requester !== null &&
            ID_RE.test(String(requester))
              ? String(requester)
              : null,
        }),
      );
      return successRes(this.toPublic(saved), 201, 'Segment saved');
    } catch (error) {
      if ((error as { code?: string })?.code === '23505')
        throw rpc(409, `"${name}" nomli segment allaqachon bor`);
      throw error;
    }
  }

  async remove(input: { id?: unknown }) {
    const id = primitiveText(input?.id).trim();
    if (!ID_RE.test(id)) throw rpc(400, "id noto'g'ri");
    const result = await this.repo.update(
      { id, isDeleted: false },
      { isDeleted: true },
    );
    if (!result.affected) throw rpc(404, 'Segment topilmadi');
    return successRes({ id }, 200, 'Segment deleted');
  }

  private toPublic(row: NotificationAudienceSegment) {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      audience: row.audience,
      last_total: row.last_total,
      last_counted_at: row.last_counted_at,
      created_by: row.created_by,
      created_at: row.createdAt,
    };
  }
}
