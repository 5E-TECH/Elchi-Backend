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
  // Set by the gateway from the JWT. Used to scope results so a low-privilege
  // account cannot harvest cross-tenant PII / order financials from the index.
  requester?: { id?: string; roles?: string[] };
}

// Sources that contain user/staff PII (phones, usernames) — privileged-only.
const PII_SOURCES = ['identity', 'identity_fallback'];
const PRIVILEGED_SEARCH_ROLES = ['superadmin', 'admin'];

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

    const roles = (payload.requester?.roles ?? []).map((r) =>
      String(r ?? '').toLowerCase(),
    );
    const requesterId = String(payload.requester?.id ?? '').trim();
    const isPrivileged = roles.some((r) =>
      PRIVILEGED_SEARCH_ROLES.includes(r),
    );

    const qb = this.docs
      .createQueryBuilder('doc')
      .where('doc.isDeleted = :isDeleted', { isDeleted: false });

    if (payload.type) {
      qb.andWhere('doc.type = :type', { type: payload.type });
    }

    if (payload.source) {
      qb.andWhere('doc.source = :source', { source: payload.source });
    }

    if (!isPrivileged) {
      // Never expose user/staff PII (phones, usernames) to non-privileged roles.
      qb.andWhere('doc.source NOT IN (:...piiSources)', {
        piiSources: PII_SOURCES,
      });
      // Order documents are owner-scoped: a non-privileged caller sees an order
      // row only when its metadata market_id/courier_id/customer_id is theirs.
      qb.andWhere(
        `(doc.source <> :orderSource OR (
            :rid <> '' AND (
              doc.metadata->>'market_id' = :rid OR
              doc.metadata->>'courier_id' = :rid OR
              doc.metadata->>'customer_id' = :rid
            )
          ))`,
        { orderSource: 'order', rid: requesterId },
      );
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

    // Strip content/metadata/tags for non-privileged callers — the projection
    // returns only enough to render a result and navigate to the entity.
    const items = isPrivileged
      ? rows
      : rows.map((r) => ({
          id: r.id,
          source: r.source,
          type: r.type,
          sourceId: r.sourceId,
          title: r.title,
        }));

    return {
      success: true,
      data: {
        items,
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
