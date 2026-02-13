import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SearchDocument } from './entities/search-document.entity';

interface UpsertPayload {
  source: string;
  type: string;
  sourceId: string;
  title: string;
  content?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface RemovePayload {
  source: string;
  type: string;
  sourceId: string;
}

interface QueryPayload {
  q?: string;
  type?: string;
  source?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class SearchServiceService {
  constructor(
    @InjectRepository(SearchDocument)
    private readonly docs: Repository<SearchDocument>,
  ) {}

  async upsert(payload: UpsertPayload) {
    if (!payload.source || !payload.type || !payload.sourceId || !payload.title) {
      throw new RpcException({ statusCode: 400, message: 'Invalid search upsert payload' });
    }

    let doc = await this.docs.findOne({
      where: {
        source: payload.source,
        type: payload.type,
        sourceId: payload.sourceId,
      },
    });

    if (!doc) {
      doc = this.docs.create({
        source: payload.source,
        type: payload.type,
        sourceId: payload.sourceId,
        title: payload.title,
        content: payload.content ?? null,
        tags: payload.tags ?? [],
        metadata: payload.metadata ?? null,
        isDeleted: false,
      });
    } else {
      doc.title = payload.title;
      doc.content = payload.content ?? null;
      doc.tags = payload.tags ?? [];
      doc.metadata = payload.metadata ?? null;
      doc.isDeleted = false;
    }

    const saved = await this.docs.save(doc);
    return { success: true, data: saved };
  }

  async remove(payload: RemovePayload) {
    const doc = await this.docs.findOne({
      where: {
        source: payload.source,
        type: payload.type,
        sourceId: payload.sourceId,
      },
    });

    if (!doc) {
      return { success: true, data: null };
    }

    doc.isDeleted = true;
    const saved = await this.docs.save(doc);
    return { success: true, data: saved };
  }

  async query(payload: QueryPayload) {
    const page = payload.page && payload.page > 0 ? payload.page : 1;
    const limit = payload.limit && payload.limit > 0 ? Math.min(payload.limit, 50) : 10;
    const skip = (page - 1) * limit;
    const q = payload.q?.trim();

    const qb = this.docs
      .createQueryBuilder('doc')
      .where('doc.isDeleted = :isDeleted', { isDeleted: false });

    if (payload.type) {
      qb.andWhere('doc.type = :type', { type: payload.type });
    }

    if (payload.source) {
      qb.andWhere('doc.source = :source', { source: payload.source });
    }

    if (q) {
      qb.andWhere(
        '(doc.title ILIKE :qLike OR doc.content ILIKE :qLike OR :qRaw = ANY(doc.tags))',
        { qLike: `%${q}%`, qRaw: q },
      );
    }

    const [rows, total] = await qb
      .orderBy('doc.updatedAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    return {
      success: true,
      data: {
        items: rows,
        meta: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      },
    };
  }
}
