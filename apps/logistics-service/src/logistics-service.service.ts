import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
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
}

interface OrderRow {
  id: string;
  total_price?: number;
  status?: Order_status;
  return_requested?: boolean;
  post_id?: string | null;
  canceled_post_id?: string | null;
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

@Injectable()
export class LogisticsServiceService implements OnModuleInit {
  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    @InjectRepository(Region) private readonly regionRepo: Repository<Region>,
    @InjectRepository(District) private readonly districtRepo: Repository<District>,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
    @Inject('SEARCH') private readonly searchClient: ClientProxy,
  ) {}

  private notFound(message: string): never {
    throw new RpcException(errorRes(message, 404));
  }

  private badRequest(message: string): never {
    throw new RpcException(errorRes(message, 400));
  }

  private conflict(message: string): never {
    throw new RpcException(errorRes(message, 409));
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
    } catch {
      // Search sync should not block logistics flows.
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
    } catch {
      // Search sync should not block logistics flows.
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
    } catch {
      // Search sync should not block logistics flows.
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
    } catch {
      // Search sync should not block logistics flows.
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
    } catch {
      // Search sync should not block logistics flows.
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
    } catch {
      // Search sync should not block logistics flows.
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
    canceled_post_id?: string;
    status?: Order_status;
    return_requested?: boolean;
    customer_id?: string;
    qr_code_token?: string;
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

  private async updateOrder(id: string, dto: Record<string, unknown>): Promise<void> {
    try {
      await lastValueFrom(
        this.orderClient.send({ cmd: 'order.update' }, { id, dto }).pipe(timeout(5000)),
      );
    } catch {
      throw new RpcException(errorRes(`Order #${id} update failed`, 502));
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

    for (const orderId of uniqueOrderIds) {
      const order = await this.findOrderById(orderId);
      totalPrice += Number(order?.total_price ?? 0);
      if (!regionId && order?.region_id) {
        regionId = String(order.region_id);
      }
    }

    const post = this.postRepo.create({
      courier_id: dto.courier_id,
      qr_code_token: dto.qr_code_token?.trim() || this.generateToken(),
      region_id: regionId,
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

  async findAllPosts(page = 1, limit = 8) {
    const take = limit > 100 ? 100 : Math.max(1, limit);
    const skip = (Math.max(1, page) - 1) * take;

    const [data, total] = await this.postRepo.findAndCount({
      where: { status: Not(Post_status.NEW) },
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

  async newPosts(query?: { region_id?: string; search?: string }) {
    const orphanOrders = await this.findOrders({ status: Order_status.RECEIVED, page: 1, limit: 1000 });
    const candidates = orphanOrders.filter((order) => !order.post_id && order.region_id);

    const byRegion = new Map<string, { ids: string[]; total: number }>();

    for (const order of candidates) {
      const regionId = String(order.region_id);
      const current = byRegion.get(regionId) ?? { ids: [], total: 0 };
      current.ids.push(order.id);
      current.total += Number(order.total_price ?? 0);
      byRegion.set(regionId, current);
    }

    for (const [regionId, payload] of byRegion.entries()) {
      let post = await this.postRepo.findOne({
        where: { region_id: regionId, status: Post_status.NEW },
      });

      if (!post) {
        post = await this.postRepo.save(
          this.postRepo.create({
            courier_id: '0',
            qr_code_token: this.generateToken(),
            region_id: regionId,
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

      post.order_quantity = Number(post.order_quantity ?? 0) + payload.ids.length;
      post.post_total_price = Number(post.post_total_price ?? 0) + payload.total;
      const savedPost = await this.postRepo.save(post);
      void this.syncPostToSearch(savedPost);
    }

    const allPosts = await this.postRepo.find({
      where: { status: Post_status.NEW },
      relations: ['region'],
      order: { createdAt: 'DESC' },
    });

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
      region: post.region_id ? regionsById.get(post.region_id) ?? null : null,
    }));

    const regionFilter = query?.region_id?.trim();
    const searchFilter = query?.search?.trim().toLowerCase();

    const filteredPosts = postsWithRegion.filter((post) => {
      if (regionFilter && String(post.region_id ?? '') !== regionFilter) {
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

  async rejectedPosts() {
    const allPosts = await this.postRepo.find({
      where: { status: Post_status.CANCELED },
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

  async findPostById(id: string) {
    const post = await this.postRepo.findOne({ where: { id } });
    if (!post) {
      this.notFound('Post not found');
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

  async getRejectedPostOrders(id: string) {
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

  async sendPost(id: string, dto: SendPostDto) {
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
        });
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
      await this.updateOrder(orderId, { post_id: id, status: Order_status.ON_THE_ROAD });
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
    const post = await this.postRepo.findOne({ where: { id, courier_id: requester.id } });
    if (!post) {
      this.notFound('Post not found');
    }
    if (post.status !== Post_status.SENT) {
      this.badRequest('Cannot receive post with this status');
    }

    const waitingOrderIds = [...new Set((dto.order_ids ?? []).map((orderId) => String(orderId)))];
    const waitingOrderIdSet = new Set(waitingOrderIds);
    const allOrders = await this.findOrders({ post_id: id, page: 1, limit: 1000 });
    const orderById = new Map(allOrders.map((order) => [String(order.id), order]));

    for (const orderId of waitingOrderIds) {
      const target = orderById.get(orderId);
      if (target?.status === Order_status.ON_THE_ROAD) {
        await this.updateOrder(orderId, {
          status: Order_status.WAITING,
          return_requested: false,
        });
      }
    }

    const remaining = allOrders.filter(
      (o) => o.status === Order_status.ON_THE_ROAD && !waitingOrderIdSet.has(String(o.id)),
    );

    if (remaining.length) {
      for (const order of remaining) {
        await this.updateOrder(order.id, {
          status: Order_status.WAITING,
          return_requested: true,
        });
      }
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

  async approveReturnRequests(dto: ReceivePostDto) {
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
        });
        addedTotal += Number(order.total_price ?? 0);
      }

      newPost.order_quantity = Number(newPost.order_quantity ?? 0) + regionOrders.length;
      newPost.post_total_price = Number(newPost.post_total_price ?? 0) + addedTotal;
      const savedNewPost = await this.postRepo.save(newPost);
      void this.syncPostToSearch(savedNewPost);
    }

    return successRes(
      { approved: eligibleOrders.length },
      200,
      'Return requests approved',
    );
  }

  async rejectReturnRequests(dto: ReceivePostDto) {
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
        await this.updateOrder(order.id, { return_requested: false });
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
    orders: Array<{ order_id: string; assigned_region: string; total_price: number }>,
  ) {
    if (!orders.length) {
      return successRes([]);
    }

    const byRegion = new Map<string, Array<{ order_id: string; total_price: number }>>();
    for (const order of orders) {
      const group = byRegion.get(order.assigned_region) ?? [];
      group.push({ order_id: order.order_id, total_price: order.total_price });
      byRegion.set(order.assigned_region, group);
    }

    const assignments: Array<{ order_id: string; post_id: string }> = [];

    for (const [regionId, regionOrders] of byRegion.entries()) {
      let post = await this.postRepo.findOne({
        where: { region_id: regionId, status: Post_status.NEW },
      });

      if (!post) {
        post = this.postRepo.create({
          courier_id: '0',
          qr_code_token: this.generateToken(),
          region_id: regionId,
          status: Post_status.NEW,
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
