import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';

type Row = Record<string, any>;

/**
 * Turns an audit-log page (raw ids) into "full data" for the frontend.
 *
 * Each row only stores ids (actor user_id, entity_id, and *_id keys inside
 * metadata/old_value/new_value). This service collects the DISTINCT ids across
 * the page, batch-resolves them via the owning services (one call per id-type,
 * mirroring order-gateway enrichOrders), and attaches resolved objects:
 *   - `actor`       — the user who performed the action (name/phone/role)
 *   - `entity`      — a summary of the row's primary entity
 *   - `references`  — { <id_field>: <resolved summary> } for ids found in the row
 *
 * Everything is best-effort: each leg is wrapped so a slow/missing service
 * never breaks the listing — the row simply keeps its raw ids.
 */
@Injectable()
export class AuditEnrichmentService {
  private readonly logger = new Logger(AuditEnrichmentService.name);
  private readonly TIMEOUT = 10000;
  // Bound the unbatched (per-id) lookups so one page can't fan out unboundedly.
  private readonly MAX_LOOP = 60;

  constructor(
    @Inject('IDENTITY') private readonly identity: ClientProxy,
    @Inject('ORDER') private readonly order: ClientProxy,
    @Inject('BRANCH') private readonly branch: ClientProxy,
    @Inject('CATALOG') private readonly catalog: ClientProxy,
    @Inject('LOGISTICS') private readonly logistics: ClientProxy,
  ) {}

  // id field name -> resolver category. Anything not listed is ignored.
  private static readonly USER_FIELDS = new Set([
    'user_id', 'created_by', 'opened_by', 'closed_by', 'receiver_user_id',
    'source_user_id', 'manager_id', 'courier_id', 'market_id', 'operator_id',
    'requester_id', 'assigned_by',
  ]);
  private static readonly CUSTOMER_FIELDS = new Set(['customer_id']);
  private static readonly BRANCH_FIELDS = new Set([
    'branch_id', 'source_branch_id', 'destination_branch_id', 'home_branch_id',
  ]);
  private static readonly PRODUCT_FIELDS = new Set(['product_id']);
  private static readonly POST_FIELDS = new Set(['post_id']);
  private static readonly ORDER_FIELDS = new Set(['order_id', 'parent_order_id']);

  async enrich(rows: Row[]): Promise<Row[]> {
    if (!Array.isArray(rows) || !rows.length) return rows ?? [];

    const userIds = new Set<string>();
    const customerIds = new Set<string>();
    const branchIds = new Set<string>();
    const productIds = new Set<string>();
    const postIds = new Set<string>();
    const orderIds = new Set<string>();

    const add = (set: Set<string>, v: unknown) => {
      const s = String(v ?? '').trim();
      if (s && s !== 'null' && s !== 'undefined') set.add(s);
    };

    // entity_type -> the set its entity_id belongs to.
    const entityRouter: Record<string, Set<string>> = {
      User: userIds, Auth: userIds,
      Order: orderIds,
      Branch: branchIds,
      Product: productIds,
      Post: postIds,
    };

    const scanObject = (obj: unknown) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [key, val] of Object.entries(obj as Row)) {
        if (val === null || val === undefined) continue;
        if (Array.isArray(val) || typeof val === 'object') continue; // don't deep-walk
        if (AuditEnrichmentService.USER_FIELDS.has(key)) add(userIds, val);
        else if (AuditEnrichmentService.CUSTOMER_FIELDS.has(key)) add(customerIds, val);
        else if (AuditEnrichmentService.BRANCH_FIELDS.has(key)) add(branchIds, val);
        else if (AuditEnrichmentService.PRODUCT_FIELDS.has(key)) add(productIds, val);
        else if (AuditEnrichmentService.POST_FIELDS.has(key)) add(postIds, val);
        else if (AuditEnrichmentService.ORDER_FIELDS.has(key)) add(orderIds, val);
      }
    };

    for (const row of rows) {
      add(userIds, row.user_id);
      const router = entityRouter[row.entity_type];
      if (router) add(router, row.entity_id);
      scanObject(row.metadata);
      scanObject(row.old_value);
      scanObject(row.new_value);
    }

    const [userMap, customerMap, productMap, postMap, branchMap, orderMap] =
      await Promise.all([
        this.resolveUsers(userIds),
        this.resolveBatch(this.identity, 'identity.customer.find_by_ids', customerIds),
        this.resolveBatch(this.catalog, 'catalog.product.find_by_ids', productIds),
        this.resolveBatch(this.logistics, 'logistics.post.find_by_ids', postIds),
        // branch.find_by_id scopes by requester; pass a system/superadmin actor
        // so the in-process enrichment lookup isn't tenant-filtered to nothing.
        this.resolveLoop(this.branch, 'branch.find_by_id', branchIds, {
          requester: { id: 'system', roles: ['superadmin'] },
        }),
        this.resolveLoop(this.order, 'order.find_by_id', orderIds),
      ]);

    const lookup = (field: string, id: unknown): Row | null => {
      const key = String(id ?? '').trim();
      if (!key) return null;
      if (AuditEnrichmentService.CUSTOMER_FIELDS.has(field)) {
        return this.userSummary(customerMap.get(key)) ?? this.userSummary(userMap.get(key));
      }
      if (AuditEnrichmentService.USER_FIELDS.has(field)) {
        return this.userSummary(userMap.get(key)) ?? this.userSummary(customerMap.get(key));
      }
      if (AuditEnrichmentService.BRANCH_FIELDS.has(field)) return this.branchSummary(branchMap.get(key));
      if (AuditEnrichmentService.PRODUCT_FIELDS.has(field)) return this.productSummary(productMap.get(key));
      if (AuditEnrichmentService.POST_FIELDS.has(field)) return this.postSummary(postMap.get(key));
      if (AuditEnrichmentService.ORDER_FIELDS.has(field)) return this.orderSummary(orderMap.get(key));
      return null;
    };

    const collectRefs = (obj: unknown, into: Row) => {
      if (!obj || typeof obj !== 'object') return;
      for (const [key, val] of Object.entries(obj as Row)) {
        if (val === null || val === undefined || Array.isArray(val) || typeof val === 'object') continue;
        if (into[key]) continue; // first wins
        const resolved = lookup(key, val);
        if (resolved) into[key] = resolved;
      }
    };

    return rows.map((row) => {
      // actor: prefer freshly-resolved user, fall back to denormalised columns.
      const actor =
        this.userSummary(userMap.get(String(row.user_id ?? ''))) ??
        (row.user_id || row.user_name
          ? { id: row.user_id ?? null, name: row.user_name ?? null, role: row.user_role ?? null }
          : null);

      // entity: resolve the row's primary subject by its type.
      let entity: Row | null = null;
      const eid = String(row.entity_id ?? '');
      switch (row.entity_type) {
        case 'User':
        case 'Auth':
          entity = this.userSummary(userMap.get(eid)) ?? this.userSummary(customerMap.get(eid));
          break;
        case 'Order': entity = this.orderSummary(orderMap.get(eid)); break;
        case 'Branch': entity = this.branchSummary(branchMap.get(eid)); break;
        case 'Product': entity = this.productSummary(productMap.get(eid)); break;
        case 'Post': entity = this.postSummary(postMap.get(eid)); break;
        default: entity = null;
      }

      const references: Row = {};
      collectRefs(row.metadata, references);
      collectRefs(row.old_value, references);
      collectRefs(row.new_value, references);

      return {
        ...row,
        actor,
        entity,
        references: Object.keys(references).length ? references : null,
      };
    });
  }

  // ---- resolvers -------------------------------------------------------

  /** Resolve staff/market/courier ids (all roles except customer/superadmin). */
  private async resolveUsers(ids: Set<string>): Promise<Map<string, Row>> {
    const map = new Map<string, Row>();
    if (!ids.size) return map;
    const all = Array.from(ids);
    // Chunk so a big page doesn't exceed the find_all id-filter window.
    for (let i = 0; i < all.length; i += 100) {
      const chunk = all.slice(i, i + 100);
      const res = await this.sendSafe(this.identity, 'identity.user.find_all', {
        query: { user_ids: chunk, limit: 100 },
      });
      const items: Row[] = res?.data?.items ?? res?.items ?? res?.data ?? [];
      for (const u of items) if (u?.id !== undefined) map.set(String(u.id), u);
    }
    return map;
  }

  private async resolveBatch(
    client: ClientProxy,
    cmd: string,
    ids: Set<string>,
  ): Promise<Map<string, Row>> {
    const map = new Map<string, Row>();
    if (!ids.size) return map;
    const res = await this.sendSafe(client, cmd, { ids: Array.from(ids) });
    const items: Row[] = Array.isArray(res) ? res : res?.data ?? res?.items ?? [];
    for (const it of items) if (it?.id !== undefined) map.set(String(it.id), it);
    return map;
  }

  /** For id-types with no batch variant (branch/order): bounded per-id loop. */
  private async resolveLoop(
    client: ClientProxy,
    cmd: string,
    ids: Set<string>,
    extra: Record<string, unknown> = {},
  ): Promise<Map<string, Row>> {
    const map = new Map<string, Row>();
    if (!ids.size) return map;
    const list = Array.from(ids).slice(0, this.MAX_LOOP);
    if (ids.size > this.MAX_LOOP) {
      this.logger.warn(`${cmd}: ${ids.size} distinct ids on page, enriching first ${this.MAX_LOOP}.`);
    }
    const results = await Promise.all(
      list.map((id) =>
        this.sendSafe(client, cmd, { id, ...extra }).then((res) => {
          const data = res?.data ?? res ?? null;
          return data && data.id !== undefined ? ([String(data.id), data] as const) : null;
        }),
      ),
    );
    for (const r of results) if (r) map.set(r[0], r[1]);
    return map;
  }

  private async sendSafe(client: ClientProxy, cmd: string, payload: unknown): Promise<any> {
    return firstValueFrom(client.send({ cmd }, payload).pipe(timeout(this.TIMEOUT))).catch(
      (err: unknown) => {
        this.logger.warn(`enrich leg ${cmd} failed: ${err instanceof Error ? err.message : 'unknown'}`);
        return null;
      },
    );
  }

  // ---- summaries (only the fields a UI needs; never secrets) -----------

  private userSummary(u?: Row): Row | null {
    if (!u) return null;
    return {
      id: String(u.id),
      name: u.name ?? null,
      username: u.username ?? null,
      phone_number: u.phone_number ?? null,
      role: u.role ?? null,
      status: u.status ?? null,
    };
  }
  private branchSummary(b?: Row): Row | null {
    if (!b) return null;
    return { id: String(b.id), name: b.name ?? null, code: b.code ?? null, type: b.type ?? null };
  }
  private productSummary(p?: Row): Row | null {
    if (!p) return null;
    return { id: String(p.id), name: p.name ?? null, image_url: p.image_url ?? null };
  }
  private postSummary(p?: Row): Row | null {
    if (!p) return null;
    return { id: String(p.id), status: p.status ?? null, courier_id: p.courier_id ?? null };
  }
  private orderSummary(o?: Row): Row | null {
    if (!o) return null;
    return {
      id: String(o.id),
      status: o.status ?? null,
      total_price: o.total_price ?? null,
      market_id: o.market_id ?? null,
      customer_id: o.customer_id ?? null,
    };
  }
}
