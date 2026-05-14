import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { In, Not, Repository } from 'typeorm';
import { lastValueFrom, timeout } from 'rxjs';
import { Post } from './entities/post.entity';
import { Region } from './entities/region.entity';
import { District } from './entities/district.entity';
import { regions } from './data/regions-districts.data';
import { CreateDistrictDto } from './dto/create-district.dto';
import { UpdateDistrictDto } from './dto/update-district.dto';
import { UpdateDistrictNameDto } from './dto/update-district-name.dto';
import { UpdateDistrictSatoCodeDto } from './dto/update-district-sato-code.dto';
import { CreateRegionDto } from './dto/create-region.dto';
import { UpdateRegionDto } from './dto/update-region.dto';
import { CreatePostDto } from './dto/create-post.dto';
import { ReceivePostDto } from './dto/receive-post.dto';
import { SendPostDto } from './dto/send-post.dto';
import { PostIdDto } from './dto/post-id.dto';
import { errorRes, successRes } from '../../../libs/common/helpers/response';
import { matchDistricts } from './utils/sato-matcher';
import { Order_status, Post_status, Roles, Where_deliver } from '@app/common';

interface RequesterContext {
  id: string;
  roles?: string[];
  note?: string | null;
}

interface OrderRow {
  id: string;
  total_price?: number;
  status?: Order_status;
  return_requested?: boolean;
  post_id?: string | null;
  canceled_post_id?: string | null;
  branch_id?: string | null;
  courier_id?: string | null;
  assigned_at?: string | Date | null;
  region_id?: string | null;
  district_id?: string | null;
  customer_id?: string;
  where_deliver?: Where_deliver;
  qr_code_token?: string | null;
}

interface CourierRow {
  id: string;
  region_id?: string | null;
  role?: string;
}

interface BranchAssignmentRow {
  branch_id?: string | null;
  role?: string | null;
}

@Injectable()
export class LogisticsServiceService implements OnModuleInit {
  private readonly logger = new Logger(LogisticsServiceService.name);

  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    @InjectRepository(Region) private readonly regionRepo: Repository<Region>,
    @InjectRepository(District) private readonly districtRepo: Repository<District>,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('SEARCH') private readonly searchClient: ClientProxy,
  ) {}

  private notFound(message: string): never {
    throw new RpcException(errorRes(message, 404));
  }

  private badRequest(message: string): never {
    throw new RpcException(errorRes(message, 400));
  }

  private forbidden(message: string): never {
    throw new RpcException(errorRes(message, 403));
  }

  private conflict(message: string): never {
    throw new RpcException(errorRes(message, 409));
  }

  private isSystemPrivileged(requester?: RequesterContext): boolean {
    const roles = (requester?.roles ?? []).map((role) => String(role ?? '').toLowerCase());
    return roles.includes(Roles.SUPERADMIN) || roles.includes(Roles.ADMIN);
  }

  private async resolveScopedBranchId(requester?: RequesterContext): Promise<string | null> {
    if (this.isSystemPrivileged(requester)) {
      return null;
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden("Foydalanuvchi aniqlanmadi");
    }

    const assignment = await this.findBranchAssignmentByUserId(requesterId, {
      id: requesterId,
      roles: requester?.roles ?? [],
    });
    const branchId = String(assignment?.branch_id ?? '').trim();
    if (!branchId) {
      this.forbidden("Foydalanuvchi branchga biriktirilmagan");
    }
    return branchId;
  }

  private generateToken(): string {
    return `POST-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private async syncPostToSearch(post: Post): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.upsert' },
            {
              source: 'logistics',
              type: 'post',
              sourceId: post.id,
              title: `Post #${post.id}`,
              content: [post.qr_code_token, post.region_id, post.courier_id, post.status]
                .filter(Boolean)
                .join(' '),
              tags: ['logistics', 'post', post.status].filter(Boolean),
              metadata: {
                region_id: post.region_id,
                courier_id: post.courier_id,
                order_quantity: post.order_quantity,
                post_total_price: post.post_total_price,
                status: post.status,
              },
            },
          )
          .pipe(timeout(1500)),
      );
    } catch (err) {
      this.logger.warn(
        `search.index.upsert (post ${post.id}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async removePostFromSearch(post: Post): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.remove' },
            { source: 'logistics', type: 'post', sourceId: post.id },
          )
          .pipe(timeout(1500)),
      );
    } catch (err) {
      this.logger.warn(
        `search.index.remove (post ${post.id}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async syncRegionToSearch(region: Region): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.upsert' },
            {
              source: 'logistics',
              type: 'region',
              sourceId: region.id,
              title: region.name,
              content: region.sato_code,
              tags: ['logistics', 'region'],
              metadata: {
                sato_code: region.sato_code,
              },
            },
          )
          .pipe(timeout(1500)),
      );
    } catch (err) {
      this.logger.warn(
        `search.index.upsert (region ${region.id}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async removeRegionFromSearch(region: Region): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.remove' },
            { source: 'logistics', type: 'region', sourceId: region.id },
          )
          .pipe(timeout(1500)),
      );
    } catch (err) {
      this.logger.warn(
        `search.index.remove (region ${region.id}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async syncDistrictToSearch(district: District): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.upsert' },
            {
              source: 'logistics',
              type: 'district',
              sourceId: district.id,
              title: district.name,
              content: [district.sato_code, district.region_id, district.assigned_region]
                .filter(Boolean)
                .join(' '),
              tags: ['logistics', 'district'],
              metadata: {
                sato_code: district.sato_code,
                region_id: district.region_id,
                assigned_region: district.assigned_region,
              },
            },
          )
          .pipe(timeout(1500)),
      );
    } catch (err) {
      this.logger.warn(
        `search.index.upsert (district ${district.id}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async removeDistrictFromSearch(district: District): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.remove' },
            { source: 'logistics', type: 'district', sourceId: district.id },
          )
          .pipe(timeout(1500)),
      );
    } catch (err) {
      this.logger.warn(
        `search.index.remove (district ${district.id}) failed: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  private async findOrderById(id: string): Promise<OrderRow> {
    try {
      return await lastValueFrom(
        this.orderClient.send({ cmd: 'order.find_by_id' }, { id }).pipe(timeout(5000)),
      );
    } catch {
      this.notFound(`Order #${id} not found`);
    }
  }

  private async findOrders(query: {
    post_id?: string;
    post_ids?: string[];
    canceled_post_id?: string;
    status?: Order_status | Order_status[] | string | string[];
    return_requested?: boolean;
    customer_id?: string;
    qr_code_token?: string;
    start_day?: string;
    end_day?: string;
    fetch_all?: boolean;
    page?: number;
    limit?: number;
  }): Promise<OrderRow[]> {
    try {
      const requestedLimit = Number(query.limit ?? 100);
      const allowedLimits = [10, 25, 50, 100];
      const normalizedLimit = allowedLimits.includes(requestedLimit)
        ? requestedLimit
        : 100;

      const useFetchAll = query.fetch_all === true || requestedLimit > 100;

      const res = await lastValueFrom(
        this.orderClient
          .send(
            { cmd: 'order.find_all' },
            {
              query: {
                ...query,
                fetch_all: useFetchAll,
                page: query.page ?? 1,
                limit: normalizedLimit,
              },
            },
          )
          .pipe(timeout(5000)),
      );

      // Support multiple RMQ response shapes:
      // 1) { statusCode, message, data: { data: OrderRow[], ... } }
      // 2) { statusCode, message, data: OrderRow[] }
      // 3) { data: { data: OrderRow[], ... } } or { data: OrderRow[] }
      // 4) OrderRow[]
      const candidates = [
        res?.data?.data?.data,
        res?.data?.data,
        res?.data,
        res,
      ];

      for (const candidate of candidates) {
        if (Array.isArray(candidate)) {
          return candidate;
        }
        if (candidate && Array.isArray((candidate as { data?: unknown }).data)) {
          return (candidate as { data: OrderRow[] }).data;
        }
      }

      return [];
    } catch {
      return [];
    }
  }

  private async updateOrder(
    id: string,
    dto: Record<string, unknown>,
    requester?: { id: string; roles?: string[]; note?: string | null },
  ): Promise<void> {
    try {
      await lastValueFrom(
        this.orderClient
          .send({ cmd: 'order.update' }, { id, dto, requester })
          .pipe(timeout(5000)),
      );
    } catch {
      throw new RpcException(errorRes(`Order #${id} update failed`, 502));
    }
  }

  private async findOrderByQrToken(qrToken: string): Promise<OrderRow> {
    try {
      const response = await lastValueFrom(
        this.orderClient
          .send({ cmd: 'order.find_by_qr' }, { token: qrToken })
          .pipe(timeout(5000)),
      );

      const candidates = [
        response?.data?.data,
        response?.data,
        response,
      ];

      for (const candidate of candidates) {
        if (candidate && typeof candidate === 'object' && 'id' in candidate) {
          return candidate as OrderRow;
        }
      }
    } catch {
      // handled below
    }

    this.notFound('Order topilmadi');
  }

  private async findCourierBranchId(requester: RequesterContext): Promise<string> {
    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden("Courier aniqlanmadi");
    }

    try {
      const response = await lastValueFrom(
        this.branchClient
          .send(
            { cmd: 'branch.user.find_by_user' },
            {
              user_id: requesterId,
              requester: { id: requesterId, roles: requester.roles ?? [Roles.COURIER] },
            },
          )
          .pipe(timeout(5000)),
      );

      const branchId = String(response?.data?.branch_id ?? '').trim();
      if (!branchId) {
        this.forbidden("Courier filialga biriktirilmagan");
      }

      return branchId;
    } catch (error) {
      if (error instanceof RpcException) {
        throw error;
      }
      this.forbidden("Courier filialini aniqlab bo'lmadi");
    }
  }

  private async findBranchAssignmentByUserId(
    userId: string,
    requester: RequesterContext,
  ): Promise<BranchAssignmentRow | null> {
    const normalizedUserId = String(userId ?? '').trim();
    if (!normalizedUserId) {
      this.badRequest('user_id is required');
    }

    try {
      const response = await lastValueFrom(
        this.branchClient
          .send(
            { cmd: 'branch.user.find_by_user' },
            {
              user_id: normalizedUserId,
              requester: { id: requester.id, roles: requester.roles ?? [Roles.BRANCH] },
            },
          )
          .pipe(timeout(5000)),
      );

      return (response?.data ?? null) as BranchAssignmentRow | null;
    } catch {
      return null;
    }
  }

  private async findBranchUsersByBranchId(
    branchId: string,
    requester: RequesterContext,
  ): Promise<Array<{ user_id?: string; role?: string }>> {
    const normalizedBranchId = String(branchId ?? '').trim();
    if (!normalizedBranchId) {
      return [];
    }

    try {
      const response = await lastValueFrom(
        this.branchClient
          .send(
            { cmd: 'branch.user.find_by_branch' },
            {
              branch_id: normalizedBranchId,
              requester: { id: requester.id, roles: requester.roles ?? [Roles.BRANCH] },
            },
          )
          .pipe(timeout(5000)),
      );

      const rows = response?.data;
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  private async listCouriers(search?: string): Promise<Array<Record<string, unknown>>> {
    try {
      const res = await lastValueFrom(
        this.identityClient
          .send({ cmd: 'identity.courier.find_all' }, { query: { search, page: 1, limit: 1000 } })
          .pipe(timeout(5000)),
      );

      return res?.data?.items ?? [];
    } catch {
      return [];
    }
  }

  private async listCouriersByRegion(regionId: string): Promise<Array<Record<string, unknown>>> {
    try {
      const res = await lastValueFrom(
        this.identityClient
          .send(
            { cmd: 'identity.courier.find_all' },
            { query: { region_id: regionId, page: 1, limit: 1000 } },
          )
          .pipe(timeout(5000)),
      );

      return res?.data?.items ?? [];
    } catch {
      return [];
    }
  }

  private async findCourierById(id: string): Promise<CourierRow | null> {
    try {
      const res = await lastValueFrom(
        this.identityClient
          .send({ cmd: 'identity.courier.find_by_ids' }, { ids: [id] })
          .pipe(timeout(5000)),
      );

      const rows = res?.data ?? [];
      return Array.isArray(rows) && rows.length ? (rows[0] as CourierRow) : null;
    } catch {
      return null;
    }
  }

  private async findCouriersByIds(ids: string[]): Promise<Map<string, Record<string, unknown>>> {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    if (!uniqueIds.length) {
      return new Map();
    }

    try {
      const res = await lastValueFrom(
        this.identityClient
          .send({ cmd: 'identity.courier.find_by_ids' }, { ids: uniqueIds })
          .pipe(timeout(5000)),
      );

      const rows = Array.isArray(res?.data) ? res.data : [];
      return new Map(
        rows
          .filter((item) => item && typeof item === 'object' && 'id' in item)
          .map((item) => [String((item as { id: string }).id), item as Record<string, unknown>]),
      );
    } catch {
      return new Map();
    }
  }

  async onModuleInit() {
    for (const [regionIndex, regionData] of regions.entries()) {
      const regionName = regionData.name.trim();
      let regionEntity = await this.regionRepo.findOne({
        where: { name: regionName },
      });

      if (!regionEntity) {
        const generatedSato = `REG-${String(regionIndex + 1).padStart(2, '0')}`;
        let satoCode = generatedSato;
        const satoExists = await this.regionRepo.findOne({
          where: { sato_code: generatedSato },
        });
        if (satoExists) {
          satoCode = `${generatedSato}-${Date.now()}`;
        }

        regionEntity = await this.regionRepo.save(
          this.regionRepo.create({
            name: regionName,
            sato_code: satoCode,
          }),
        );
        void this.syncRegionToSearch(regionEntity);
      }

      for (const [districtIndex, districtNameRaw] of regionData.districts.entries()) {
        const districtName = districtNameRaw.trim();
        const exists = await this.districtRepo.findOne({
          where: { name: districtName, region_id: regionEntity.id },
        });

        if (exists) {
          continue;
        }

        const district = this.districtRepo.create({
          name: districtName,
          sato_code: `REG-${String(regionIndex + 1).padStart(2, '0')}-DIS-${String(districtIndex + 1).padStart(2, '0')}`,
          region_id: regionEntity.id,
          assigned_region: regionEntity.id,
        });
        const savedDistrict = await this.districtRepo.save(district);
        void this.syncDistrictToSearch(savedDistrict);
      }
    }
  }

  async createPost(dto: CreatePostDto) {
    if (!dto.courier_id?.trim()) {
      this.badRequest('courier_id is required');
    }

    const uniqueOrderIds = [...new Set((dto.orderIDs ?? []).filter(Boolean))];
    let totalPrice = 0;
    let regionId: string | null = null;
    let branchIdFromOrders: string | null = null;

    for (const orderId of uniqueOrderIds) {
      const order = await this.findOrderById(orderId);
      totalPrice += Number(order?.total_price ?? 0);
      if (!regionId && order?.region_id) {
        regionId = String(order.region_id);
      }
      if (!branchIdFromOrders && order?.branch_id) {
        branchIdFromOrders = String(order.branch_id);
      }
    }

    const courierAssignment = await this.findBranchAssignmentByUserId(
      dto.courier_id,
      { id: dto.courier_id, roles: [Roles.COURIER] },
    );
    const branchId =
      (courierAssignment?.branch_id ? String(courierAssignment.branch_id) : null) ??
      branchIdFromOrders;

    const post = this.postRepo.create({
      courier_id: dto.courier_id,
      qr_code_token: dto.qr_code_token?.trim() || this.generateToken(),
      region_id: regionId,
      branch_id: branchId,
      post_total_price: totalPrice,
      order_quantity: uniqueOrderIds.length,
      status: Post_status.NEW,
    });

    const savedPost = await this.postRepo.save(post);
    void this.syncPostToSearch(savedPost);

    for (const orderId of uniqueOrderIds) {
      await this.updateOrder(orderId, {
        post_id: savedPost.id,
        status: Order_status.RECEIVED,
      });
    }

    return successRes(savedPost, 201, 'Post created');
  }

  async findAllPosts(
    page = 1,
    limit = 8,
    filters?: { branch_id?: string; status?: string },
    requester?: RequesterContext,
  ) {
    const take = limit > 100 ? 100 : Math.max(1, limit);
    const skip = (Math.max(1, page) - 1) * take;

    const scopedBranchId = await this.resolveScopedBranchId(requester);
    const branchId = scopedBranchId ?? (filters?.branch_id ? String(filters.branch_id).trim() : '');
    const status = filters?.status ? String(filters.status).trim().toLowerCase() : '';
    const where: Record<string, unknown> = { status: Not(Post_status.NEW) };
    if (branchId) {
      where.branch_id = branchId;
    }
    if (status) {
      const allowedStatuses = new Set<string>([
        Post_status.NEW,
        Post_status.SENT,
        Post_status.RECEIVED,
        Post_status.CANCELED,
        Post_status.CANCELED_RECEIVED,
      ]);
      if (allowedStatuses.has(status)) {
        where.status = status;
      }
    }

    const [data, total] = await this.postRepo.findAndCount({
      where,
      relations: ['region'],
      order: { createdAt: 'DESC' },
      skip,
      take,
    });

    return successRes(
      {
        data,
        total,
        page: Math.max(1, page),
        totalPages: Math.max(1, Math.ceil(total / take)),
        limit: take,
      },
      200,
      'All posts (paginated)',
    );
  }

  async newPosts(query?: { search?: string }, requester?: RequesterContext) {
    const scopedBranchId = await this.resolveScopedBranchId(requester);
    const orphanOrders = await this.findOrders({ status: Order_status.RECEIVED, page: 1, limit: 1000 });
    const candidates = orphanOrders.filter(
      (order) =>
        !order.post_id &&
        order.region_id &&
        order.branch_id &&
        (!scopedBranchId || String(order.branch_id) === scopedBranchId),
    );

    const byBranchRegion = new Map<string, { regionId: string; branchId: string; ids: string[]; total: number }>();

    for (const order of candidates) {
      const regionId = String(order.region_id);
      const branchId = String(order.branch_id);
      const key = `${branchId}:${regionId}`;
      const current = byBranchRegion.get(key) ?? { regionId, branchId, ids: [], total: 0 };
      current.ids.push(order.id);
      current.total += Number(order.total_price ?? 0);
      byBranchRegion.set(key, current);
    }

    for (const payload of byBranchRegion.values()) {
      let post = await this.postRepo.findOne({
        where: {
          region_id: payload.regionId,
          branch_id: payload.branchId,
          status: Post_status.NEW,
        },
      });

      if (!post) {
        post = await this.postRepo.save(
          this.postRepo.create({
            courier_id: '0',
            qr_code_token: this.generateToken(),
            region_id: payload.regionId,
            branch_id: payload.branchId,
            status: Post_status.NEW,
            post_total_price: 0,
            order_quantity: 0,
          }),
        );
        void this.syncPostToSearch(post);
      }

      for (const orderId of payload.ids) {
        await this.updateOrder(orderId, { post_id: post.id });
      }

      // Atomic increment — avoids lost-update if newPosts is invoked
      // concurrently for the same region.
      const incrementCount = payload.ids.length;
      const incrementTotal = Number.isFinite(payload.total) ? payload.total : 0;
      await this.postRepo
        .createQueryBuilder()
        .update(Post)
        .set({
          order_quantity: () => `order_quantity + ${incrementCount}`,
          post_total_price: () => `post_total_price + ${incrementTotal}`,
        })
        .where('id = :id', { id: post.id })
        .execute();
      const refreshedPost = await this.postRepo.findOne({ where: { id: post.id } });
      if (refreshedPost) {
        void this.syncPostToSearch(refreshedPost);
      }
    }

    const allPosts = await this.postRepo.find({
      where: { status: Post_status.NEW },
      relations: ['region'],
      order: { createdAt: 'DESC' },
    });

    const postIds = allPosts.map((post) => String(post.id)).filter(Boolean);
    const postOrders = postIds.length
      ? await this.findOrders({
          post_ids: postIds,
          fetch_all: true,
          limit: 100,
        })
      : [];
    const orderStatsByPostId = new Map<string, { count: number; total: number }>();
    for (const order of postOrders) {
      const postId = String(order.post_id ?? '').trim();
      if (!postId) {
        continue;
      }
      const current = orderStatsByPostId.get(postId) ?? { count: 0, total: 0 };
      current.count += 1;
      current.total += Number(order.total_price ?? 0);
      orderStatsByPostId.set(postId, current);
    }

    const regionIds = Array.from(
      new Set(allPosts.map((post) => post.region_id).filter((id): id is string => Boolean(id))),
    );

    const regionsById = new Map<string, Region>();
    if (regionIds.length) {
      const linkedRegions = await this.regionRepo.find({
        where: { id: In(regionIds) },
      });
      for (const region of linkedRegions) {
        regionsById.set(region.id, region);
      }
    }

    const postsWithRegion = allPosts.map((post) => ({
      ...post,
      order_quantity: orderStatsByPostId.get(String(post.id))?.count ?? 0,
      post_total_price: orderStatsByPostId.get(String(post.id))?.total ?? 0,
      region: post.region_id ? regionsById.get(post.region_id) ?? null : null,
    }));

    const searchFilter = query?.search?.trim().toLowerCase();

    const filteredPosts = postsWithRegion.filter((post) => {
      if (scopedBranchId && String(post.branch_id ?? '') !== scopedBranchId) {
        return false;
      }
      if (searchFilter) {
        const regionName = String(post.region?.name ?? '').toLowerCase();
        if (!regionName.includes(searchFilter)) {
          return false;
        }
      }

      return true;
    });

    return successRes(filteredPosts, 200, 'All new posts');
  }

  async rejectedPosts(requester?: RequesterContext) {
    const scopedBranchId = await this.resolveScopedBranchId(requester);
    const where: Record<string, unknown> = { status: Post_status.CANCELED };
    if (scopedBranchId) {
      where.branch_id = scopedBranchId;
    }

    const allPosts = await this.postRepo.find({
      where,
      relations: ['region'],
      order: { createdAt: 'DESC' },
    });
    const courierMap = await this.findCouriersByIds(
      allPosts.map((post) => post.courier_id).filter(Boolean) as string[],
    );
    const enrichedPosts = allPosts.map((post) => ({
      ...post,
      courier: post.courier_id ? courierMap.get(post.courier_id) ?? null : null,
    }));
    return successRes(enrichedPosts, 200, 'All rejected posts');
  }

  async onTheRoadPosts(requester: RequesterContext) {
    const allPosts = await this.postRepo.find({
      where: { status: Post_status.SENT, courier_id: requester.id },
      relations: ['region'],
      order: { createdAt: 'DESC' },
    });
    return successRes(allPosts, 200, 'All on-the-road posts');
  }

  async oldPostsForCourier(page: number, limit: number, requester: RequesterContext) {
    const take = limit > 100 ? 100 : Math.max(1, limit);
    const skip = (Math.max(1, page) - 1) * take;

    const [data, total] = await this.postRepo.findAndCount({
      where: {
        courier_id: requester.id,
        status: Not(In([Post_status.SENT, Post_status.NEW])),
      },
      relations: ['region'],
      order: { createdAt: 'DESC' },
      skip,
      take,
    });

    return successRes(
      {
        data,
        total,
        page: Math.max(1, page),
        totalPages: Math.max(1, Math.ceil(total / take)),
        limit: take,
      },
      200,
      'All old posts',
    );
  }

  async rejectedPostsForCourier(requester: RequesterContext) {
    const rows = await this.postRepo.find({
      where: { status: Post_status.CANCELED, courier_id: requester.id },
      relations: ['region'],
      order: { createdAt: 'DESC' },
    });
    const courierMap = await this.findCouriersByIds(
      rows.map((post) => post.courier_id).filter(Boolean) as string[],
    );
    const enrichedRows = rows.map((post) => ({
      ...post,
      courier: post.courier_id ? courierMap.get(post.courier_id) ?? null : null,
    }));
    return successRes(enrichedRows, 200, 'All rejected posts for courier');
  }

  async myPostsForCourier(page: number, limit: number, requester: RequesterContext) {
    const take = limit > 100 ? 100 : Math.max(1, limit);
    const skip = (Math.max(1, page) - 1) * take;

    const [data, total] = await this.postRepo.findAndCount({
      where: { courier_id: requester.id },
      relations: ['region'],
      order: { createdAt: 'DESC' },
      skip,
      take,
    });

    return successRes(
      {
        data,
        total,
        page: Math.max(1, page),
        totalPages: Math.max(1, Math.ceil(total / take)),
        limit: take,
      },
      200,
      'All my posts',
    );
  }

  async findPostById(id: string, requester?: RequesterContext) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }
    const scopedBranchId = await this.resolveScopedBranchId(requester);
    if (scopedBranchId && String(post.branch_id ?? '') !== scopedBranchId) {
      this.forbidden("Siz bu branch pochtasini ko'ra olmaysiz");
    }
    return successRes(post, 200, 'Post found');
  }

  async deletePost(id: string) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }

    await this.postRepo.remove(post);
    void this.removePostFromSearch(post);
    return successRes({ id }, 200, 'Post deleted');
  }

  async findPostsByIds(ids: string[]) {
    if (!ids.length) {
      return successRes([], 200, 'Posts found');
    }

    const posts = await this.postRepo.find({
      where: { id: In(ids) },
    });

    return successRes(posts, 200, 'Posts found');
  }

  async findPostWithQr(token: string) {
    const post = await this.postRepo.findOne({ where: { qr_code_token: token } });
    if (!post) {
      this.notFound('Post not found');
    }
    return successRes(post, 200, 'Post found');
  }

  async findAllCouriersByPostId(id: string) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }

    const couriers = post.region_id
      ? await this.listCouriersByRegion(post.region_id)
      : await this.listCouriers();
    if (!couriers.length) {
      this.notFound('There are not any couriers for this region');
    }

    return successRes(
      {
        moreThanOneCourier: couriers.length > 1,
        couriers,
      },
      200,
      'Couriers for this post',
    );
  }

  async getPostOrders(id: string, requester: RequesterContext) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }
    const scopedBranchId = await this.resolveScopedBranchId(requester);
    if (scopedBranchId && String(post.branch_id ?? '') !== scopedBranchId) {
      this.forbidden("Siz bu branch pochtasidagi orderlarni ko'ra olmaysiz");
    }

    const [ordersByPostId, ordersByCanceledPostId] = await Promise.all([
      this.findOrders({
        post_id: id,
        page: 1,
        limit: 1000,
      }),
      this.findOrders({
        canceled_post_id: id,
        page: 1,
        limit: 1000,
      }),
    ]);

    const orderMap = new Map<string, OrderRow>();
    for (const order of [...ordersByPostId, ...ordersByCanceledPostId]) {
      orderMap.set(String(order.id), order);
    }

    let orders = Array.from(orderMap.values());

    const isCourier = (requester.roles ?? []).some(
      (role) => String(role).toLowerCase() === Roles.COURIER,
    );
    if (post.status === Post_status.SENT && isCourier) {
      orders = orders.filter((order) => order.status === Order_status.ON_THE_ROAD);
    }

    let homeOrders = 0;
    let centerOrders = 0;
    let homeOrdersTotalPrice = 0;
    let centerOrdersTotalPrice = 0;

    for (const order of orders) {
      if (order.where_deliver === Where_deliver.ADDRESS) {
        homeOrders += 1;
        homeOrdersTotalPrice += Number(order.total_price ?? 0);
      } else {
        centerOrders += 1;
        centerOrdersTotalPrice += Number(order.total_price ?? 0);
      }
    }

    return successRes(
      {
        allOrdersByPostId: orders,
        homeOrders: { homeOrders, homeOrdersTotalPrice },
        centerOrders: { centerOrders, centerOrdersTotalPrice },
      },
      200,
      'All orders by post id',
    );
  }

  async getCourierSentPostOrders(id: string, requester: RequesterContext) {
    const post = await this.postRepo.findOne({ where: { id, courier_id: requester.id } });
    if (!post) {
      this.notFound('Post not found');
    }
    if (post.status !== Post_status.SENT) {
      this.badRequest('Only sent posts are available for courier');
    }

    return this.getPostOrders(id, requester);
  }

  async getRejectedPostOrders(id: string, requester?: RequesterContext) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }
    const scopedBranchId = await this.resolveScopedBranchId(requester);
    if (scopedBranchId && String(post.branch_id ?? '') !== scopedBranchId) {
      this.forbidden("Siz bu branch pochtasidagi rejected orderlarni ko'ra olmaysiz");
    }

    const orders = await this.findOrders({
      canceled_post_id: id,
      page: 1,
      limit: 1000,
    });
    return successRes(orders, 200, 'All rejected orders by post id');
  }

  async checkPost(qrToken: string, dto: PostIdDto) {
    if (!dto.postId) {
      this.badRequest('Post not found');
    }

    const orders = await this.findOrders({
      post_id: dto.postId,
      status: Order_status.RECEIVED,
      qr_code_token: qrToken,
      page: 1,
      limit: 1,
    });

    if (!orders.length) {
      this.notFound('Order not found');
    }

    return successRes({ order: { id: orders[0].id } }, 200, "Order checked and it's exist");
  }

  async checkCancelPost(qrToken: string, dto: PostIdDto) {
    if (!dto.postId) {
      this.badRequest('Post not found');
    }

    const orders = await this.findOrders({
      canceled_post_id: dto.postId,
      status: Order_status.CANCELLED_SENT,
      qr_code_token: qrToken,
      page: 1,
      limit: 1,
    });

    if (!orders.length) {
      this.notFound('Order not found');
    }

    return successRes({ order: { id: orders[0].id } }, 200, "Order checked and it's exist");
  }

  async sendPost(id: string, dto: SendPostDto, requester?: RequesterContext) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }

    const courier = await this.findCourierById(dto.courierId);
    if (!courier) {
      this.notFound('Courier not found');
    }

    if (!dto.orderIds?.length) {
      this.badRequest('You can not send an empty post');
    }

    const currentOrders = await this.findOrders({ post_id: id, page: 1, limit: 1000 });
    if (!currentOrders.length) {
      this.badRequest('Post has no orders');
    }

    const currentIds = currentOrders.map((o) => o.id);
    const selectedIds = [...new Set(dto.orderIds.filter(Boolean))];
    const invalidIds = selectedIds.filter((orderId) => !currentIds.includes(orderId));
    if (invalidIds.length) {
      this.badRequest('Some selected orders are not inside this post');
    }
    const remainingIds = currentIds.filter((orderId) => !selectedIds.includes(orderId));
    const trackingNote =
      dto.description?.trim() ||
      "Post jo'natildi: status received dan on_the_road ga o'tdi";
    const trackingRequester =
      requester && requester.id
        ? { id: requester.id, roles: requester.roles ?? [], note: trackingNote }
        : { id: 'system', roles: [], note: trackingNote };

    let selectedTotal = 0;
    let regionId = post.region_id;
    const selectedOrders: OrderRow[] = [];
    for (const orderId of selectedIds) {
      const order = await this.findOrderById(orderId);
      selectedOrders.push(order);
      selectedTotal += Number(order.total_price ?? 0);
      if (!regionId && order.region_id) {
        regionId = String(order.region_id);
      }
    }

    // If we send a subset, keep remaining orders in old NEW post and create a fresh SENT post.
    if (remainingIds.length > 0) {
      let remainingTotal = 0;
      for (const orderId of remainingIds) {
        const order = currentOrders.find((item) => item.id === orderId);
        remainingTotal += Number(order?.total_price ?? 0);
        await this.updateOrder(orderId, { post_id: post.id, status: Order_status.RECEIVED });
      }

      const sentPost = await this.postRepo.save(
        this.postRepo.create({
          courier_id: dto.courierId,
          qr_code_token: this.generateToken(),
          region_id: regionId,
          status: Post_status.SENT,
          post_total_price: selectedTotal,
          order_quantity: selectedIds.length,
        }),
      );

      for (const orderId of selectedIds) {
        await this.updateOrder(orderId, {
          post_id: sentPost.id,
          status: Order_status.ON_THE_ROAD,
        }, trackingRequester);
      }

      post.courier_id = '0';
      post.status = Post_status.NEW;
      post.order_quantity = remainingIds.length;
      post.post_total_price = remainingTotal;
      post.region_id = regionId;
      const sourcePost = await this.postRepo.save(post);

      void this.syncPostToSearch(sourcePost);
      void this.syncPostToSearch(sentPost);
      return successRes(
        {
          updatedPost: sentPost,
          sourcePost,
          newOrders: selectedOrders,
          postTotalInfo: {
            total: selectedIds.length,
            sum: selectedTotal,
          },
        },
        200,
        'Post sent successfully',
      );
    }

    // If all orders selected, send current post as before.
    for (const orderId of selectedIds) {
      await this.updateOrder(
        orderId,
        { post_id: id, status: Order_status.ON_THE_ROAD },
        trackingRequester,
      );
    }

    post.courier_id = dto.courierId;
    post.status = Post_status.SENT;
    post.order_quantity = selectedIds.length;
    post.post_total_price = selectedTotal;
    post.region_id = regionId;

    const updatedPost = await this.postRepo.save(post);
    void this.syncPostToSearch(updatedPost);
    return successRes(
      {
        updatedPost,
        newOrders: selectedOrders,
        postTotalInfo: {
          total: selectedIds.length,
          sum: selectedTotal,
        },
      },
      200,
      'Post sent successfully',
    );
  }

  async receivePost(requester: RequesterContext, id: string, dto: ReceivePostDto) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }
    const scopedBranchId = await this.resolveScopedBranchId(requester);
    if (scopedBranchId && String(post.branch_id ?? '') !== scopedBranchId) {
      this.forbidden("Siz bu branch pochtasini qabul qila olmaysiz");
    }

    const requesterRoles = (requester?.roles ?? []).map((role) => String(role ?? '').toLowerCase());
    const requesterId = String(requester?.id ?? '').trim();
    const requesterIsCourier = requesterRoles.includes(Roles.COURIER);
    if (
      requesterIsCourier &&
      !this.isSystemPrivileged(requester) &&
      requesterId &&
      String(post.courier_id ?? '') !== requesterId
    ) {
      this.forbidden("Courier faqat o'ziga biriktirilgan pochtani qabul qilishi mumkin");
    }

    if (post.status !== Post_status.SENT) {
      this.badRequest('Cannot receive post with this status');
    }

    const waitingOrderIds = [...new Set((dto.order_ids ?? []).map((orderId) => String(orderId)))];
    const waitingOrderIdSet = new Set(waitingOrderIds);
    const allOrders = await this.findOrders({ post_id: id, page: 1, limit: 1000 });
    const orderById = new Map(allOrders.map((order) => [String(order.id), order]));

    // receivePost spans multiple updateOrder RMQ calls + a local postRepo.save
    // across two services — no atomic TX possible. Track which transitions
    // succeeded so partial failures are visible in logs rather than silent.
    const failures: Array<{ order_id: string; error: string }> = [];

    for (const orderId of waitingOrderIds) {
      const target = orderById.get(orderId);
      if (target?.status === Order_status.ON_THE_ROAD) {
        try {
          await this.updateOrder(orderId, {
            status: Order_status.WAITING,
            return_requested: false,
          });
        } catch (err) {
          failures.push({
            order_id: String(orderId),
            error: (err as Error)?.message ?? String(err),
          });
        }
      }
    }

    const remaining = allOrders.filter(
      (o) => o.status === Order_status.ON_THE_ROAD && !waitingOrderIdSet.has(String(o.id)),
    );

    if (remaining.length) {
      for (const order of remaining) {
        try {
          await this.updateOrder(order.id, {
            status: Order_status.WAITING,
            return_requested: true,
          });
        } catch (err) {
          failures.push({
            order_id: String(order.id),
            error: (err as Error)?.message ?? String(err),
          });
        }
      }
    }

    if (failures.length > 0) {
      this.logger.warn(
        `receivePost partial failure for post=${id}: ${failures.length} order update(s) failed — operator should reconcile. Sample: ${failures
          .slice(0, 3)
          .map((f) => `${f.order_id}:${f.error}`)
          .join(' | ')}`,
      );
    }

    post.status = Post_status.RECEIVED;
    const savedPost = await this.postRepo.save(post);
    void this.syncPostToSearch(savedPost);

    const waitingOrders = waitingOrderIds.length
      ? await Promise.all(waitingOrderIds.map((orderId) => this.findOrderById(orderId)))
      : [];

    return successRes(waitingOrders, 200, 'Post received successfully');
  }

  async reassignCourier(postId: string, courierId: string) {
    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) {
      this.notFound('Post not found');
    }
    if (post.status !== Post_status.SENT) {
      this.badRequest("Only sent post can be reassigned");
    }
    if (post.courier_id === courierId) {
      this.badRequest('Post already assigned to this courier');
    }

    const courier = await this.findCourierById(courierId);
    if (!courier) {
      this.notFound('Courier not found');
    }

    const oldCourierId = post.courier_id;
    post.courier_id = courierId;
    const updatedPost = await this.postRepo.save(post);
    void this.syncPostToSearch(updatedPost);

    return successRes(
      {
        post_id: updatedPost.id,
        old_courier_id: oldCourierId,
        new_courier_id: courierId,
      },
      200,
      'Post reassigned successfully',
    );
  }

  async getReturnRequests() {
    const orders = await this.findOrders({
      status: Order_status.WAITING,
      return_requested: true,
      page: 1,
      limit: 1000,
    });

    const postIds = Array.from(
      new Set(orders.map((order) => order.post_id).filter((id): id is string => Boolean(id))),
    );
    const posts = postIds.length
      ? await this.postRepo.find({ where: { id: In(postIds) } })
      : [];
    const postMap = new Map(posts.map((post) => [post.id, post]));

    const courierIds = Array.from(
      new Set(posts.map((post) => post.courier_id).filter((id): id is string => Boolean(id))),
    );
    const courierMap = await this.findCouriersByIds(courierIds);

    const groups = new Map<
      string,
      { courier: Record<string, unknown> | null; courier_id: string | null; orders: OrderRow[] }
    >();

    for (const order of orders) {
      const post = order.post_id ? postMap.get(String(order.post_id)) : undefined;
      const courierId = post?.courier_id ?? null;
      const key = courierId ?? 'unknown';

      if (!groups.has(key)) {
        groups.set(key, {
          courier: courierId ? courierMap.get(courierId) ?? null : null,
          courier_id: courierId,
          orders: [],
        });
      }
      groups.get(key)!.orders.push(order);
    }

    return successRes(
      { total: orders.length, groups: Array.from(groups.values()) },
      200,
      'Return requests',
    );
  }

  async approveReturnRequests(dto: ReceivePostDto, requester?: RequesterContext) {
    const orderIds = [...new Set((dto.order_ids ?? []).map((id) => String(id)).filter(Boolean))];
    if (!orderIds.length) {
      this.badRequest('Order IDs required');
    }

    const eligibleOrders: OrderRow[] = [];
    for (const orderId of orderIds) {
      const order = await this.findOrderById(orderId);
      if (
        order.status === Order_status.WAITING &&
        order.return_requested === true
      ) {
        eligibleOrders.push(order);
      }
    }

    if (!eligibleOrders.length) {
      this.notFound('No return-requested orders found');
    }

    const postIds = Array.from(
      new Set(
        eligibleOrders
          .map((order) => order.post_id)
          .filter((postId): postId is string => Boolean(postId)),
      ),
    );
    const currentPosts = postIds.length
      ? await this.postRepo.find({ where: { id: In(postIds) } })
      : [];
    const currentPostMap = new Map(currentPosts.map((post) => [post.id, post]));

    const ordersByRegion = new Map<string, OrderRow[]>();
    for (const order of eligibleOrders) {
      const fallbackRegion = order.post_id ? currentPostMap.get(order.post_id)?.region_id : null;
      const regionId = String(order.region_id ?? fallbackRegion ?? '');
      if (!regionId) {
        this.badRequest(`Order #${order.id} has no region`);
      }
      const bucket = ordersByRegion.get(regionId) ?? [];
      bucket.push(order);
      ordersByRegion.set(regionId, bucket);
    }

    for (const [regionId, regionOrders] of ordersByRegion.entries()) {
      let newPost = await this.postRepo.findOne({
        where: { region_id: regionId, status: Post_status.NEW },
      });

      if (!newPost) {
        newPost = await this.postRepo.save(
          this.postRepo.create({
            courier_id: '0',
            region_id: regionId,
            order_quantity: 0,
            post_total_price: 0,
            status: Post_status.NEW,
            qr_code_token: this.generateToken(),
          }),
        );
      }

      let addedTotal = 0;
      for (const order of regionOrders) {
        await this.updateOrder(order.id, {
          status: Order_status.RECEIVED,
          return_requested: false,
          post_id: newPost.id,
        }, {
          id: requester?.id ?? 'system',
          roles: requester?.roles ?? [],
          note: requester?.note ?? "Qaytarish so'rovi tasdiqlandi — buyurtma pochtaga qaytarildi",
        });
        addedTotal += Number(order.total_price ?? 0);
      }

      const incrementCount = regionOrders.length;
      const incrementTotal = Number.isFinite(addedTotal) ? addedTotal : 0;
      await this.postRepo
        .createQueryBuilder()
        .update(Post)
        .set({
          order_quantity: () => `order_quantity + ${incrementCount}`,
          post_total_price: () => `post_total_price + ${incrementTotal}`,
        })
        .where('id = :id', { id: newPost.id })
        .execute();
      const savedNewPost = await this.postRepo.findOne({ where: { id: newPost.id } });
      if (savedNewPost) {
        void this.syncPostToSearch(savedNewPost);
      }
    }

    return successRes(
      { approved: eligibleOrders.length },
      200,
      'Return requests approved',
    );
  }

  async rejectReturnRequests(dto: ReceivePostDto, requester?: RequesterContext) {
    const orderIds = [...new Set((dto.order_ids ?? []).map((id) => String(id)).filter(Boolean))];
    if (!orderIds.length) {
      this.badRequest('Order IDs required');
    }

    let rejected = 0;
    for (const orderId of orderIds) {
      const order = await this.findOrderById(orderId);
      if (
        order.status === Order_status.WAITING &&
        order.return_requested === true
      ) {
        await this.updateOrder(
          order.id,
          { return_requested: false },
          {
            id: requester?.id ?? 'system',
            roles: requester?.roles ?? [],
            note: requester?.note ?? "Qaytarish so'rovi rad etildi — buyurtma kuryerda qoldi",
          },
        );
        rejected += 1;
      }
    }

    if (!rejected) {
      this.notFound('No return-requested orders found');
    }

    return successRes(
      { rejected },
      200,
      'Return requests rejected',
    );
  }

  async receivePostWithScanner(requester: RequesterContext, token: string) {
    const post = await this.postRepo.findOne({ where: { qr_code_token: token, courier_id: requester.id } });
    if (!post) {
      this.notFound('Post not found');
    }
    if (post.status !== Post_status.SENT) {
      this.badRequest('Post can not be received');
    }

    const orders = await this.findOrders({
      post_id: post.id,
      status: Order_status.ON_THE_ROAD,
      page: 1,
      limit: 1000,
    });

    if (!orders.length) {
      this.notFound('There are not orders in this post');
    }

    for (const order of orders) {
      await this.updateOrder(order.id, { status: Order_status.WAITING });
    }

    post.status = Post_status.RECEIVED;
    const savedPost = await this.postRepo.save(post);
    void this.syncPostToSearch(savedPost);

    return successRes({}, 200, 'Post received successfully');
  }

  async receiveOrderWithScannerCourier(requester: RequesterContext, orderId: string) {
    const order = await this.findOrderById(orderId);
    if (!order.post_id) {
      this.notFound('Order has no post');
    }

    const post = await this.postRepo.findOne({ where: { id: String(order.post_id), courier_id: requester.id } });
    if (!post) {
      this.notFound('Post not found or not assigned to this courier');
    }

    await this.updateOrder(order.id, { status: Order_status.WAITING });

    const remaining = await this.findOrders({
      post_id: post.id,
      status: Order_status.ON_THE_ROAD,
      page: 1,
      limit: 1,
    });

    if (!remaining.length) {
      post.status = Post_status.RECEIVED;
      const savedPost = await this.postRepo.save(post);
      void this.syncPostToSearch(savedPost);
    }

    return successRes({}, 200, 'Order received');
  }

  async scanAssignOrder(
    requester: RequesterContext,
    dto: { qr_token: string },
  ) {
    const qrToken = String(dto?.qr_token ?? '').trim();
    if (!qrToken) {
      this.badRequest('qr_token is required');
    }

    const order = await this.findOrderByQrToken(qrToken);
    const courierBranchId = await this.findCourierBranchId(requester);
    const orderBranchId = String(order.branch_id ?? '').trim();

    if (!orderBranchId) {
      this.badRequest("Order filialga biriktirilmagan");
    }

    if (orderBranchId !== courierBranchId) {
      this.forbidden("Boshqa filial orderi — qabul qila olmaysiz");
    }

    const requesterId = String(requester.id);
    const currentCourierId = String(order.courier_id ?? '').trim();
    if (currentCourierId && currentCourierId !== requesterId) {
      this.badRequest("Order allaqachon boshqa courierga biriktirilgan");
    }

    const currentStatus = order.status;
    const isAlreadyAssignedToCurrentCourier =
      currentCourierId === requesterId && currentStatus === Order_status.ON_THE_ROAD;

    if (!isAlreadyAssignedToCurrentCourier) {
      if (
        currentStatus !== Order_status.NEW &&
        currentStatus !== Order_status.RECEIVED &&
        currentStatus !== Order_status.WAITING_CUSTOMER
      ) {
        this.badRequest(
          "Order holati noto'g'ri: faqat NEW, RECEIVED yoki WAITING_CUSTOMER bo'lishi kerak",
        );
      }
    }

    let targetPost: Post | null = null;
    if (order.post_id) {
      targetPost = await this.postRepo.findOne({
        where: { id: String(order.post_id), courier_id: requesterId },
      });
    }

    if (!targetPost) {
      targetPost = await this.postRepo.findOne({
        where: { courier_id: requesterId, status: Post_status.SENT },
        order: { createdAt: 'DESC' },
      });
    }

    const createdNewPost = !targetPost;
    if (!targetPost) {
      const created = this.postRepo.create({
        courier_id: requesterId,
        region_id: order.region_id ? String(order.region_id) : null,
        order_quantity: 0,
        post_total_price: 0,
        qr_code_token: this.generateToken(),
        status: Post_status.SENT,
      });
      targetPost = await this.postRepo.save(created);
      void this.syncPostToSearch(targetPost);
    }

    if (isAlreadyAssignedToCurrentCourier) {
      return successRes(
        {
          idempotent: true,
          order_id: String(order.id),
          post_id: targetPost.id,
          post_created: false,
        },
        200,
        'Order already assigned to this courier',
      );
    }

    if (currentStatus === Order_status.NEW) {
      await this.updateOrder(
        String(order.id),
        { status: Order_status.RECEIVED },
        {
          id: requesterId,
          roles: requester.roles ?? [Roles.COURIER],
          note: "Order skan orqali courierga biriktirish oldidan RECEIVED holatiga o'tkazildi",
        },
      );
    }

    await this.updateOrder(
      String(order.id),
      {
        courier_id: requesterId,
        assigned_at: new Date().toISOString(),
        status: Order_status.ON_THE_ROAD,
        post_id: targetPost.id,
      },
      {
        id: requesterId,
        roles: requester.roles ?? [Roles.COURIER],
        note: 'Order skan orqali courierga biriktirildi',
      },
    );

    const alreadyInTargetPost = String(order.post_id ?? '') === String(targetPost.id);
    if (!alreadyInTargetPost) {
      // Atomic UPDATE — read-modify-write would lose increments under
      // concurrent scans for the same post (two couriers, two QR scans).
      const delta = Number(order.total_price ?? 0);
      try {
        await this.postRepo
          .createQueryBuilder()
          .update(Post)
          .set({
            order_quantity: () => 'order_quantity + 1',
            post_total_price: () => `post_total_price + ${Number.isFinite(delta) ? delta : 0}`,
          })
          .where('id = :id', { id: targetPost.id })
          .execute();
        const refreshedPost = await this.postRepo.findOne({ where: { id: targetPost.id } });
        if (refreshedPost) {
          void this.syncPostToSearch(refreshedPost);
        }
      } catch (err) {
        // Order has already been transitioned to ON_THE_ROAD; counter drift
        // here is recoverable from order.post_id (computed on demand). Log
        // so ops can spot persistent failures.
        this.logger.warn(
          `Post counter update failed for post=${targetPost.id} order=${order.id}: ${(err as Error)?.message ?? err}`,
        );
      }
    }

    return successRes(
      {
        idempotent: false,
        order_id: String(order.id),
        post_id: targetPost.id,
        post_created: createdNewPost,
      },
      200,
      'Order courierga biriktirildi',
    );
  }

  async assignOrdersToCourier(
    requester: RequesterContext,
    dto: { order_ids: string[]; courier_id: string },
  ) {
    const orderIds = Array.from(new Set((dto?.order_ids ?? []).map((id) => String(id).trim()).filter(Boolean)));
    const courierId = String(dto?.courier_id ?? '').trim();

    if (!orderIds.length) {
      this.badRequest('order_ids bo‘sh bo‘lishi mumkin emas');
    }
    if (!courierId) {
      this.badRequest('courier_id is required');
    }

    const requesterId = String(requester?.id ?? '').trim();
    if (!requesterId) {
      this.forbidden('Requester aniqlanmadi');
    }

    const requesterAssignment = await this.findBranchAssignmentByUserId(
      requesterId,
      requester,
    );
    const requesterBranchId = String(requesterAssignment?.branch_id ?? '').trim();
    const requesterBranchRole = String(requesterAssignment?.role ?? '').trim().toUpperCase();

    if (!requesterBranchId) {
      this.forbidden("Manager yoki registrator filialga biriktirilmagan");
    }
    if (requesterBranchRole !== 'MANAGER' && requesterBranchRole !== 'REGISTRATOR') {
      this.forbidden('Faqat MANAGER yoki REGISTRATOR orderlarni courierga ommaviy biriktira oladi');
    }

    const branchUsers = await this.findBranchUsersByBranchId(
      requesterBranchId,
      requester,
    );
    const courierInBranch = branchUsers.find(
      (item) =>
        String(item?.user_id ?? '').trim() === courierId &&
        String(item?.role ?? '').trim().toUpperCase() === 'COURIER',
    );

    if (!courierInBranch) {
      this.badRequest('Courier ushbu filialga COURIER sifatida biriktirilmagan');
    }

    const orders = await Promise.all(orderIds.map((id) => this.findOrderById(id)));

    const firstBranchId = String(orders[0]?.branch_id ?? '').trim();
    if (!firstBranchId) {
      this.badRequest("Order(lar) filialga biriktirilmagan");
    }

    if (firstBranchId !== requesterBranchId) {
      this.forbidden("Manager/registrator faqat o'z filiali orderlarini biriktira oladi");
    }

    const hasMixedBranch = orders.some(
      (order) => String(order?.branch_id ?? '').trim() !== firstBranchId,
    );
    if (hasMixedBranch) {
      this.badRequest('Orderlar aralash filialdan: faqat bitta filial orderlarini tanlang');
    }

    const invalidStatusOrder = orders.find(
      (order) =>
        order.status !== Order_status.NEW &&
        order.status !== Order_status.RECEIVED,
    );
    if (invalidStatusOrder) {
      this.badRequest(
        `Order #${invalidStatusOrder.id} holati noto'g'ri: faqat NEW yoki RECEIVED bo'lishi kerak`,
      );
    }

    const assignedToAnotherCourier = orders.find((order) => {
      const currentCourierId = String(order?.courier_id ?? '').trim();
      return currentCourierId && currentCourierId !== courierId;
    });
    if (assignedToAnotherCourier) {
      this.badRequest(
        `Order #${assignedToAnotherCourier.id} allaqachon boshqa courierga biriktirilgan`,
      );
    }

    let targetPost = await this.postRepo.findOne({
      where: { courier_id: courierId, status: Post_status.SENT },
      order: { createdAt: 'DESC' },
    });

    const createdNewPost = !targetPost;
    if (!targetPost) {
      targetPost = await this.postRepo.save(
        this.postRepo.create({
          courier_id: courierId,
          region_id: orders[0]?.region_id ? String(orders[0].region_id) : null,
          order_quantity: 0,
          post_total_price: 0,
          qr_code_token: this.generateToken(),
          status: Post_status.SENT,
        }),
      );
      void this.syncPostToSearch(targetPost);
    }

    const updatedOrderSnapshots: Array<{
      id: string;
      previous: {
        courier_id: string | null;
        assigned_at: string | Date | null;
        status: Order_status | undefined;
        post_id: string | null;
      };
    }> = [];

    let affectedCount = 0;
    let affectedTotal = 0;

    try {
      for (const order of orders) {
        const orderId = String(order.id);
        const previous = {
          courier_id: order.courier_id ?? null,
          assigned_at: order.assigned_at ?? null,
          status: order.status,
          post_id: order.post_id ?? null,
        };

        if (order.status === Order_status.NEW) {
          await this.updateOrder(
            orderId,
            { status: Order_status.RECEIVED },
            {
              id: requesterId,
              roles: requester.roles ?? [Roles.BRANCH],
              note: 'Bulk assign oldidan NEW -> RECEIVED',
            },
          );
        }

        await this.updateOrder(
          orderId,
          {
            courier_id: courierId,
            assigned_at: new Date().toISOString(),
            status: Order_status.ON_THE_ROAD,
            post_id: targetPost.id,
          },
          {
            id: requesterId,
            roles: requester.roles ?? [Roles.BRANCH],
            note: 'Manager tomonidan ommaviy courier biriktirish',
          },
        );

        updatedOrderSnapshots.push({ id: orderId, previous });
        affectedCount += 1;
        affectedTotal += Number(order.total_price ?? 0);
      }

      targetPost.order_quantity = Number(targetPost.order_quantity ?? 0) + affectedCount;
      targetPost.post_total_price = Number(targetPost.post_total_price ?? 0) + affectedTotal;
      const savedPost = await this.postRepo.save(targetPost);
      void this.syncPostToSearch(savedPost);
    } catch (error) {
      for (const snapshot of updatedOrderSnapshots) {
        try {
          await this.updateOrder(
            snapshot.id,
            {
              courier_id: snapshot.previous.courier_id,
              assigned_at: snapshot.previous.assigned_at,
              status: snapshot.previous.status,
              post_id: snapshot.previous.post_id,
            },
            {
              id: requesterId,
              roles: requester.roles ?? [Roles.BRANCH],
              note: 'Bulk assign rollback',
            },
          );
        } catch {
          // best effort rollback
        }
      }

      if (createdNewPost && targetPost?.id) {
        try {
          await this.postRepo.remove(targetPost);
        } catch {
          // ignore cleanup failures
        }
      }

      throw error;
    }

    return successRes(
      {
        order_ids: orderIds,
        courier_id: courierId,
        post_id: targetPost.id,
        post_created: createdNewPost,
        assigned_count: orderIds.length,
      },
      200,
      'Orderlar courierga biriktirildi',
    );
  }

  async createCanceledPost(requester: RequesterContext, dto: ReceivePostDto) {
    const orderIds = [...new Set(dto.order_ids ?? [])];
    if (!orderIds.length) {
      this.badRequest('No orders provided');
    }

    const orders: OrderRow[] = [];
    for (const orderId of orderIds) {
      const order = await this.findOrderById(orderId);
      if (order.status !== Order_status.CANCELLED) {
        this.badRequest('Some orders are not in CANCELED status');
      }
      orders.push(order);
    }

    let canceledPost = await this.postRepo.findOne({
      where: { courier_id: requester.id, status: Post_status.CANCELED },
    });

    if (!canceledPost) {
      canceledPost = await this.postRepo.save(
        this.postRepo.create({
          courier_id: requester.id,
          region_id: orders.find((o) => o.region_id)?.region_id ?? null,
          post_total_price: 0,
          order_quantity: 0,
          qr_code_token: this.generateToken(),
          status: Post_status.CANCELED,
        }),
      );
      void this.syncPostToSearch(canceledPost);
    }

    let addedTotal = 0;
    for (const order of orders) {
      await this.updateOrder(order.id, {
        canceled_post_id: canceledPost.id,
        status: Order_status.CANCELLED_SENT,
      });
      addedTotal += Number(order.total_price ?? 0);
    }

    canceledPost.order_quantity = Number(canceledPost.order_quantity ?? 0) + orders.length;
    canceledPost.post_total_price = Number(canceledPost.post_total_price ?? 0) + addedTotal;
    const savedCanceledPost = await this.postRepo.save(canceledPost);
    void this.syncPostToSearch(savedCanceledPost);

    return successRes(
      { post_id: canceledPost.id, order_ids: orderIds },
      200,
      'Canceled orders successfully sent to central post',
    );
  }

  async receiveCanceledPost(id: string, dto: ReceivePostDto) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
    }
    if (post.status !== Post_status.CANCELED) {
      this.badRequest('Post with this status can not be received');
    }

    const allOrders = await this.findOrders({
      canceled_post_id: id,
      status: Order_status.CANCELLED_SENT,
      page: 1,
      limit: 1000,
    });

    const canceledOrderIds = [...new Set(dto.order_ids ?? [])];
    const allOrderIdsForPost = allOrders.map((o) => o.id);
    const invalidIds = canceledOrderIds.filter((orderId) => !allOrderIdsForPost.includes(orderId));

    if (invalidIds.length) {
      this.badRequest(`Some order_ids do not belong to this post: ${invalidIds.join(', ')}`);
    }

    for (const orderId of canceledOrderIds) {
      await this.updateOrder(orderId, { status: Order_status.CLOSED });
    }

    const remainingOrderIds = allOrderIdsForPost.filter((orderId) => !canceledOrderIds.includes(orderId));
    for (const orderId of remainingOrderIds) {
      await this.updateOrder(orderId, {
        status: Order_status.CANCELLED,
        canceled_post_id: null,
      });
    }

    post.status = Post_status.CANCELED_RECEIVED;
    const savedPost = await this.postRepo.save(post);
    void this.syncPostToSearch(savedPost);

    return successRes({}, 200, 'Post received successfully');
  }

  async createDistrict(dto: CreateDistrictDto) {
    const region = await this.regionRepo.findOne({ where: { id: dto.region_id } });
    if (!region) {
      this.notFound('Region not found');
    }

    const trimmedName = dto.name.trim();
    const satoCode = dto.sato_code?.trim() ?? '';

    const exists = await this.districtRepo.findOne({
      where: { name: trimmedName, region_id: dto.region_id },
    });
    if (exists) {
      this.conflict('District already exists in this region');
    }

    if (satoCode) {
      const existingBySato = await this.districtRepo.findOne({
        where: { sato_code: satoCode },
      });
      if (existingBySato) {
        this.conflict('District sato_code already exists');
      }
    }

    const district = this.districtRepo.create({
      name: trimmedName,
      sato_code: satoCode,
      region_id: dto.region_id,
      assigned_region: dto.region_id,
    });
    const saved = await this.districtRepo.save(district);
    void this.syncDistrictToSearch(saved);
    return successRes(saved, 201, 'New district added');
  }

  async findAllDistricts() {
    const districts = await this.districtRepo.find({
      relations: ['region', 'assignedToRegion'],
      order: { createdAt: 'DESC' },
    });
    return successRes(districts);
  }

  async findDistrictById(id: string) {
    const district = await this.districtRepo.findOne({
      where: { id },
      relations: ['region', 'assignedToRegion'],
    });
    if (!district) {
      this.notFound('District not found');
    }
    return successRes(district);
  }

  async findDistrictsByIds(ids: string[]) {
    if (!ids.length) {
      return successRes([]);
    }
    const districts = await this.districtRepo.find({
      where: { id: In(ids) },
      relations: ['region', 'assignedToRegion'],
    });
    return successRes(districts);
  }

  async updateDistrict(id: string, dto: UpdateDistrictDto) {
    const district = await this.districtRepo.findOne({ where: { id } });
    if (!district) {
      this.notFound('District not found');
    }

    if (district.assigned_region === dto.assigned_region) {
      this.badRequest('The district already assigned to this region');
    }

    const assigningRegion = await this.regionRepo.findOne({
      where: { id: dto.assigned_region },
    });
    if (!assigningRegion) {
      this.notFound('The region you are trying to assign does not exist');
    }

    district.assigned_region = assigningRegion.id;
    district.assignedToRegion = assigningRegion;

    const saved = await this.districtRepo.save(district);
    void this.syncDistrictToSearch(saved);
    return successRes(saved, 200, 'District assigned to new region');
  }

  async updateDistrictName(id: string, dto: UpdateDistrictNameDto) {
    const district = await this.districtRepo.findOne({ where: { id } });
    if (!district) {
      this.notFound('District not found');
    }

    const trimmedName = dto.name.trim();
    if (!trimmedName) {
      this.badRequest('District name is required');
    }

    const duplicate = await this.districtRepo.findOne({
      where: { name: trimmedName, region_id: district.region_id },
    });
    if (duplicate && duplicate.id !== district.id) {
      this.conflict('District name already exists in this region');
    }

    district.name = trimmedName;
    const savedDistrict = await this.districtRepo.save(district);
    void this.syncDistrictToSearch(savedDistrict);
    return successRes({}, 200, 'District name updated');
  }

  async updateDistrictSatoCode(id: string, dto: UpdateDistrictSatoCodeDto) {
    const district = await this.districtRepo.findOne({ where: { id } });
    if (!district) {
      this.notFound('District not found');
    }

    const satoCode = dto.sato_code.trim();
    if (!satoCode) {
      this.badRequest('District sato_code is required');
    }

    const existingWithCode = await this.districtRepo.findOne({
      where: { sato_code: satoCode },
    });
    if (existingWithCode && existingWithCode.id !== id) {
      this.conflict('District sato_code already exists');
    }

    district.sato_code = satoCode;
    const savedDistrict = await this.districtRepo.save(district);
    void this.syncDistrictToSearch(savedDistrict);
    return successRes(savedDistrict, 200, 'District sato_code updated');
  }

  async findDistrictBySatoCode(satoCode: string) {
    const district = await this.districtRepo.findOne({
      where: { sato_code: satoCode },
      relations: ['region', 'assignedToRegion'],
    });
    if (!district) {
      this.notFound('District not found');
    }
    return successRes(district);
  }

  async matchDistrictSatoCodes() {
    const dbDistricts = await this.districtRepo.find({
      relations: ['region'],
    });

    return successRes(matchDistricts(dbDistricts), 200, 'SATO matching natijasi');
  }

  async applyDistrictSatoCodes() {
    const dbDistricts = await this.districtRepo.find({
      relations: ['region'],
    });
    const matchResult = matchDistricts(dbDistricts);

    let appliedCount = 0;
    const applied: Array<{ id: string; name: string; sato_code: string }> = [];

    for (const match of matchResult.matched) {
      if (match.satoName !== '(allaqachon mavjud)') {
        await this.districtRepo.update(match.dbId, {
          sato_code: match.satoCode,
        });
        applied.push({
          id: match.dbId,
          name: match.dbName,
          sato_code: match.satoCode,
        });
        appliedCount++;
      }
    }

    const updatedIds = applied.map((item) => item.id);
    if (updatedIds.length) {
      const updatedDistricts = await this.districtRepo.find({
        where: { id: In(updatedIds) },
      });
      updatedDistricts.forEach((district) => {
        void this.syncDistrictToSearch(district);
      });
    }

    return successRes(
      {
        applied,
        appliedCount,
        unmatched: matchResult.unmatched,
        duplicates: matchResult.duplicates,
        stats: matchResult.stats,
      },
      200,
      appliedCount + " ta tumanga SATO code qo'shildi",
    );
  }

  async deleteDistrict(id: string) {
    const district = await this.districtRepo.findOne({ where: { id } });
    if (!district) {
      this.notFound('District not found');
    }

    await this.districtRepo.remove(district);
    void this.removeDistrictFromSearch(district);
    return successRes({ id }, 200, 'District deleted');
  }

  async createRegion(dto: CreateRegionDto) {
    const name = dto.name.trim();
    const satoCode = dto.sato_code.trim();

    if (!name || !satoCode) {
      this.badRequest('name and sato_code are required');
    }

    const existingByName = await this.regionRepo.findOne({ where: { name } });
    if (existingByName) {
      this.conflict('Region name already exists');
    }

    const existingBySato = await this.regionRepo.findOne({
      where: { sato_code: satoCode },
    });
    if (existingBySato) {
      this.conflict('Region sato_code already exists');
    }

    const region = this.regionRepo.create({ name, sato_code: satoCode });
    const saved = await this.regionRepo.save(region);
    void this.syncRegionToSearch(saved);
    return successRes(saved, 201, 'Region created');
  }

  async findAllRegions() {
    const rows = await this.regionRepo.find({
      relations: ['districts'],
      order: { createdAt: 'DESC' },
    });
    return successRes(rows);
  }

  async getAllRegionsStats(startDate?: string, endDate?: string) {
    const regions = await this.regionRepo.find({
      relations: ['districts'],
      order: { name: 'ASC' },
    });

    const regionIds = regions.map((region) => String(region.id));
    const regionIdSet = new Set(regionIds);

    const orders = await this.findOrders({
      fetch_all: true,
      start_day: startDate,
      end_day: endDate,
      limit: 100,
    });

    const deliveredStatuses = new Set<Order_status>([
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
    ]);
    const cancelledStatuses = new Set<Order_status>([
      Order_status.CANCELLED,
      Order_status.CANCELLED_SENT,
    ]);

    const statsByRegion = new Map<
      string,
      { totalOrders: number; deliveredOrders: number; cancelledOrders: number; revenue: number }
    >();

    for (const regionId of regionIds) {
      statsByRegion.set(regionId, {
        totalOrders: 0,
        deliveredOrders: 0,
        cancelledOrders: 0,
        revenue: 0,
      });
    }

    for (const order of orders) {
      const regionId = String(order.region_id ?? '').trim();
      if (!regionId || !regionIdSet.has(regionId)) {
        continue;
      }

      const stats = statsByRegion.get(regionId);
      if (!stats) {
        continue;
      }

      const status = order.status as Order_status | undefined;
      const price = Number(order.total_price ?? 0);

      stats.totalOrders += 1;

      if (status && deliveredStatuses.has(status)) {
        stats.deliveredOrders += 1;
        stats.revenue += Number.isFinite(price) ? price : 0;
      }

      if (status && cancelledStatuses.has(status)) {
        stats.cancelledOrders += 1;
      }
    }

    const rows = regions.map((region) => {
      const stats = statsByRegion.get(String(region.id)) ?? {
        totalOrders: 0,
        deliveredOrders: 0,
        cancelledOrders: 0,
        revenue: 0,
      };

      return {
        id: region.id,
        name: region.name,
        sato_code: region.sato_code,
        districts_count: Array.isArray(region.districts) ? region.districts.length : 0,
        ...stats,
      };
    });

    const summary = rows.reduce(
      (acc, row) => {
        acc.totalRegions += 1;
        acc.totalOrders += row.totalOrders;
        acc.deliveredOrders += row.deliveredOrders;
        acc.cancelledOrders += row.cancelledOrders;
        acc.totalRevenue += row.revenue;
        return acc;
      },
      {
        totalRegions: 0,
        totalOrders: 0,
        deliveredOrders: 0,
        cancelledOrders: 0,
        totalRevenue: 0,
      },
    );

    return successRes(
      {
        regions: rows,
        summary,
      },
      200,
      'Region stats',
    );
  }

  async getRegionDetailedStats(id: string, startDate?: string, endDate?: string) {
    const regionId = String(id ?? '').trim();
    if (!regionId) {
      this.badRequest('Region id is required');
    }

    const region = await this.regionRepo.findOne({
      where: { id: regionId },
      relations: ['districts'],
    });

    if (!region) {
      this.notFound('Region not found');
    }

    const orders = await this.findOrders({
      fetch_all: true,
      start_day: startDate,
      end_day: endDate,
      limit: 100,
    });

    const deliveredStatuses = new Set<Order_status>([
      Order_status.SOLD,
      Order_status.PAID,
      Order_status.PARTLY_PAID,
    ]);
    const cancelledStatuses = new Set<Order_status>([
      Order_status.CANCELLED,
      Order_status.CANCELLED_SENT,
    ]);

    const regionOrders = orders.filter(
      (order) => String(order.region_id ?? '').trim() === regionId,
    );

    const summarizeOrders = (rows: OrderRow[]) => {
      let totalOrders = 0;
      let deliveredOrders = 0;
      let cancelledOrders = 0;
      let totalRevenue = 0;

      for (const order of rows) {
        totalOrders += 1;
        const status = order.status as Order_status | undefined;
        const price = Number(order.total_price ?? 0);

        if (status && deliveredStatuses.has(status)) {
          deliveredOrders += 1;
          totalRevenue += Number.isFinite(price) ? price : 0;
        }

        if (status && cancelledStatuses.has(status)) {
          cancelledOrders += 1;
        }
      }

      const pendingOrders = Math.max(0, totalOrders - deliveredOrders - cancelledOrders);
      const successRate =
        totalOrders > 0 ? Math.round((deliveredOrders / totalOrders) * 100) : 0;

      return {
        totalOrders,
        deliveredOrders,
        cancelledOrders,
        pendingOrders,
        totalRevenue,
        successRate,
      };
    };

    const couriersRaw = await this.listCouriersByRegion(regionId);
    const couriers = couriersRaw.map((courier) => {
      const courierId = String(courier?.id ?? '').trim();
      const courierOrders = regionOrders.filter(
        (order) => String(order.courier_id ?? '').trim() === courierId,
      );
      const stats = summarizeOrders(courierOrders);
      const districtId = String(courier?.district_id ?? '').trim();

      return {
        id: courierId || null,
        name: String(courier?.name ?? ''),
        phoneNumber: String(courier?.phone_number ?? courier?.phoneNumber ?? ''),
        status: courier?.status ?? null,
        districtId: districtId || null,
        totalOrders: stats.totalOrders,
        deliveredOrders: stats.deliveredOrders,
        cancelledOrders: stats.cancelledOrders,
        totalRevenue: stats.totalRevenue,
        successRate: stats.successRate,
      };
    });

    const districts = (Array.isArray(region.districts) ? region.districts : []).map((district) => {
      const districtId = String(district.id);
      const districtOrders = regionOrders.filter(
        (order) => String(order.district_id ?? '').trim() === districtId,
      );
      const stats = summarizeOrders(districtOrders);
      const districtCouriers = couriers
        .filter((courier) => String(courier.districtId ?? '') === districtId)
        .map((courier) => ({
          id: courier.id,
          name: courier.name,
          phone_number: courier.phoneNumber,
        }));

      return {
        id: district.id,
        name: district.name,
        satoCode: district.sato_code,
        couriers: districtCouriers,
        totalOrders: stats.totalOrders,
        deliveredOrders: stats.deliveredOrders,
        cancelledOrders: stats.cancelledOrders,
        totalRevenue: stats.totalRevenue,
        successRate: stats.successRate,
      };
    });

    const summary = summarizeOrders(regionOrders);
    const activeCouriers = couriers.filter(
      (courier) => String(courier.status ?? '').toLowerCase() === 'active',
    ).length;

    const topCourier = couriers
      .slice()
      .sort((a, b) => b.deliveredOrders - a.deliveredOrders)[0];

    return successRes(
      {
        region: {
          id: region.id,
          name: region.name,
          satoCode: region.sato_code,
          mainCourier: topCourier
            ? {
                id: topCourier.id,
                name: topCourier.name,
                phone_number: topCourier.phoneNumber,
              }
            : null,
        },
        summary: {
          totalOrders: summary.totalOrders,
          deliveredOrders: summary.deliveredOrders,
          cancelledOrders: summary.cancelledOrders,
          pendingOrders: summary.pendingOrders,
          totalRevenue: summary.totalRevenue,
          successRate: summary.successRate,
          totalCouriers: couriers.length,
          activeCouriers,
          totalDistricts: districts.length,
        },
        couriers: couriers.sort((a, b) => b.deliveredOrders - a.deliveredOrders),
        districts: districts.sort((a, b) => b.totalOrders - a.totalOrders),
      },
      200,
      'Region detailed stats',
    );
  }

  async findRegionById(id: string) {
    const region = await this.regionRepo.findOne({
      where: { id },
      relations: ['districts'],
    });
    if (!region) {
      this.notFound('Region not found');
    }
    return successRes(region);
  }

  async receiveOrdersIntoPosts(
    orders: Array<{
      order_id: string;
      assigned_region: string;
      total_price: number;
      assigned_branch?: string;
      assigned_post_status?: Post_status;
    }>,
  ) {
    if (!orders.length) {
      return successRes([]);
    }

    const byBranchRegion = new Map<
      string,
      Array<{
        order_id: string;
        total_price: number;
        assigned_region: string;
        assigned_branch?: string;
        assigned_post_status?: Post_status;
      }>
    >();
    for (const order of orders) {
      const branchId = String(order.assigned_branch ?? '').trim();
      const regionId = String(order.assigned_region ?? '').trim();
      const targetPostStatus = order.assigned_post_status ?? Post_status.NEW;
      const key = `${branchId}:${regionId}`;
      const group = byBranchRegion.get(key) ?? [];
      group.push({
        order_id: order.order_id,
        total_price: order.total_price,
        assigned_region: regionId,
        assigned_branch: branchId || undefined,
        assigned_post_status: targetPostStatus,
      });
      byBranchRegion.set(key, group);
    }

    const assignments: Array<{ order_id: string; post_id: string }> = [];

    for (const regionOrders of byBranchRegion.values()) {
      const first = regionOrders[0];
      const regionId = String(first?.assigned_region ?? '').trim();
      const branchId = String(first?.assigned_branch ?? '').trim();
      const targetPostStatus = first?.assigned_post_status ?? Post_status.NEW;
      let post = await this.postRepo.findOne({
        where: {
          region_id: regionId,
          ...(branchId ? { branch_id: branchId } : {}),
          status: targetPostStatus,
        },
      });

      if (!post) {
        post = this.postRepo.create({
          courier_id: '0',
          qr_code_token: this.generateToken(),
          region_id: regionId,
          branch_id: branchId || null,
          status: targetPostStatus,
          post_total_price: 0,
          order_quantity: 0,
        });
        post = await this.postRepo.save(post);
        void this.syncPostToSearch(post);
      }

      let addedTotal = 0;
      for (const ro of regionOrders) {
        assignments.push({ order_id: ro.order_id, post_id: post.id });
        addedTotal += Number(ro.total_price ?? 0);
      }

      post.order_quantity = Number(post.order_quantity ?? 0) + regionOrders.length;
      post.post_total_price = Number(post.post_total_price ?? 0) + addedTotal;
      const saved = await this.postRepo.save(post);
      void this.syncPostToSearch(saved);
    }

    return successRes(assignments, 200, 'Posts assigned');
  }

  async findRegionsByIds(ids: string[]) {
    if (!ids.length) {
      return successRes([]);
    }
    const regions = await this.regionRepo.find({
      where: { id: In(ids) },
    });
    return successRes(regions);
  }

  async updateRegion(id: string, dto: UpdateRegionDto) {
    const region = await this.regionRepo.findOne({ where: { id } });
    if (!region) {
      this.notFound('Region not found');
    }

    if (typeof dto.name !== 'undefined') {
      const nextName = dto.name.trim();
      if (!nextName) {
        this.badRequest('name cannot be empty');
      }
      const existing = await this.regionRepo.findOne({ where: { name: nextName } });
      if (existing && existing.id !== id) {
        this.conflict('Region name already exists');
      }
      region.name = nextName;
    }

    if (typeof dto.sato_code !== 'undefined') {
      const nextSato = dto.sato_code.trim();
      if (!nextSato) {
        this.badRequest('sato_code cannot be empty');
      }
      const existing = await this.regionRepo.findOne({
        where: { sato_code: nextSato },
      });
      if (existing && existing.id !== id) {
        this.conflict('Region sato_code already exists');
      }
      region.sato_code = nextSato;
    }

    const saved = await this.regionRepo.save(region);
    void this.syncRegionToSearch(saved);
    return successRes(saved, 200, 'Region updated');
  }

  async deleteRegion(id: string) {
    const region = await this.regionRepo.findOne({ where: { id } });
    if (!region) {
      this.notFound('Region not found');
    }

    await this.regionRepo.remove(region);
    void this.removeRegionFromSearch(region);
    return successRes({ id }, 200, 'Region deleted');
  }
}
