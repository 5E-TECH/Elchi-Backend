import {
  Body,
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
  GoneException,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Roles as RoleEnum } from '@app/common';
import { firstValueFrom, map, TimeoutError, timeout } from 'rxjs';
import {
  ApiCreatedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Public } from './auth/public.decorator';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import { projectOrderPayloadForRoles } from './auth/order-role-projection';
import {
  AssignRegionLogistRequestDto,
  BulkAssignRegionLogistRequestDto,
  CreateRegionRequestDto,
  CreateDistrictRequestDto,
  MergeDistrictRequestDto,
  ReassignPostRequestDto,
  PostIdRequestDto,
  ReceivePostRequestDto,
  ReturnRequestsActionRequestDto,
  SendPostRequestDto,
  UpdateRegionRequestDto,
  UpdateDistrictNameRequestDto,
  UpdateDistrictRequestDto,
  UpdateDistrictSatoCodeRequestDto,
} from './dto/logistics.swagger.dto';

interface JwtUser {
  sub: string;
  roles?: string[];
  branch_id?: string | null;
}

interface OrderRowForEnrichment {
  market_id?: string;
  customer_id?: string;
  district_id?: string | null;
  region_id?: string | null;
  [key: string]: unknown;
}

/** CODE-12 — o'chirilgan eski pochta route'lari (PATCH post/:id, post/reassign/:id). */
export const LEGACY_POST_ROUTE_DISABLED_MESSAGE =
  "Bu eski pochta amali o'chirilgan (buyurtma custody'sini tekshiruvsiz o'zgartirardi). Pochtani filialga POST /branches/posts/:postId/dispatch, kuryerga esa POST /orders/assign-to-courier yoki skan orqali bering";

/** logistics.post.return_requests javobi: kuryer bo'yicha guruhlangan qatorlar. */
interface ReturnRequestsResponse {
  data?: {
    groups?: Array<{
      orders?: OrderRowForEnrichment[];
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

@ApiTags('Logistics')
@Controller()
export class LogisticsGatewayController {
  constructor(
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  private sendLogisticsWithTimeout(pattern: { cmd: string }, payload: object) {
    return firstValueFrom(
      this.logisticsClient.send(pattern, payload).pipe(timeout(8000)),
    ).catch((error: unknown) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException('Logistics service response timeout');
      }
      throw error;
    });
  }

  private async enrichOrderRows(rows: OrderRowForEnrichment[]) {
    const marketIds = Array.from(
      new Set(rows.map((row) => row.market_id).filter(Boolean) as string[]),
    );
    const customerIds = Array.from(
      new Set(rows.map((row) => row.customer_id).filter(Boolean) as string[]),
    );
    const districtIds = Array.from(
      new Set(rows.map((row) => row.district_id).filter(Boolean) as string[]),
    );

    const [markets, customers, districts] = await Promise.all([
      Promise.all(
        marketIds.map(async (itemId) => {
          try {
            const res = await firstValueFrom(
              this.identityClient
                .send({ cmd: 'identity.market.find_by_id' }, { id: itemId })
                .pipe(timeout(8000)),
            );
            return [itemId, res?.data ?? res ?? null] as const;
          } catch {
            return [itemId, null] as const;
          }
        }),
      ),
      Promise.all(
        customerIds.map(async (itemId) => {
          try {
            const res = await firstValueFrom(
              this.identityClient
                .send({ cmd: 'identity.customer.find_by_id' }, { id: itemId })
                .pipe(timeout(8000)),
            );
            return [itemId, res?.data ?? res ?? null] as const;
          } catch {
            return [itemId, null] as const;
          }
        }),
      ),
      Promise.all(
        districtIds.map(async (itemId) => {
          try {
            const res = await firstValueFrom(
              this.logisticsClient
                .send({ cmd: 'logistics.district.find_by_id' }, { id: itemId })
                .pipe(timeout(8000)),
            );
            return [itemId, res?.data ?? res ?? null] as const;
          } catch {
            return [itemId, null] as const;
          }
        }),
      ),
    ]);

    const marketMap = new Map(markets);
    const customerMap = new Map(customers);
    const districtMap = new Map(districts);

    return rows.map((row) => ({
      ...row,
      market: row.market_id ? (marketMap.get(row.market_id) ?? null) : null,
      customer: row.customer_id
        ? (customerMap.get(row.customer_id) ?? null)
        : null,
      district: row.district_id
        ? (districtMap.get(row.district_id) ?? null)
        : null,
    }));
  }

  private async enrichOrdersByPostResponse(response: {
    data?: {
      allOrdersByPostId?: OrderRowForEnrichment[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }) {
    const rows = response?.data?.allOrdersByPostId ?? [];
    const enrichedRows = await this.enrichOrderRows(rows);

    return {
      ...response,
      data: {
        ...(response?.data ?? {}),
        allOrdersByPostId: enrichedRows,
      },
    };
  }

  private async enrichRejectedOrdersByPostResponse(response: {
    data?: OrderRowForEnrichment[];
    [key: string]: unknown;
  }) {
    const rows = Array.isArray(response?.data) ? response.data : [];
    const enrichedRows = await this.enrichOrderRows(rows);

    return {
      ...response,
      data: enrichedRows,
    };
  }

  /**
   * Qaytarish so'rovlari kuryer bo'yicha guruhlangan keladi. order.find_all
   * faqat items/branch ni qo'shadi — mijoz, tuman va marketsiz kartada
   * "Mijoz #id" / "Telefon yo'q" chiqardi va menejer posilkani topa olmasdi.
   * Barcha guruh qatorlari BIR marta boyitiladi, so'ng tartib bo'yicha
   * guruhlarga qaytariladi.
   */
  private async enrichReturnRequestsResponse(response: ReturnRequestsResponse) {
    const groups = Array.isArray(response?.data?.groups)
      ? response.data.groups
      : [];
    const ordersOf = (group: (typeof groups)[number]) =>
      Array.isArray(group?.orders) ? group.orders : [];
    const rows = groups.flatMap((group) => ordersOf(group));
    if (!rows.length) {
      return response;
    }

    const enrichedRows = await this.enrichOrderRows(rows);
    let offset = 0;
    const enrichedGroups = groups.map((group) => {
      const count = ordersOf(group).length;
      const orders = enrichedRows.slice(offset, offset + count);
      offset += count;
      return { ...group, orders };
    });

    return {
      ...response,
      data: {
        ...(response?.data ?? {}),
        groups: enrichedGroups,
      },
    };
  }

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Logistics service health check' })
  health() {
    return this.logisticsClient
      .send({ cmd: 'logistics.health' }, {})
      .pipe(timeout(8000));
  }

  // ---------- Post ----------
  @Get('post')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.COURIER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all posts (with pagination)' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['new', 'sent', 'received', 'canceled', 'canceled_received'],
  })
  @ApiQuery({ name: 'branch_id', required: false, type: String })
  getAllPosts(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('branch_id') branchId?: string,
    @Req() req?: { user?: JwtUser },
  ) {
    return this.logisticsClient
      .send(
        { cmd: 'logistics.post.find_all' },
        {
          query: {
            page: page ? Number(page) : 1,
            limit: limit ? Number(limit) : 8,
            status: status ? String(status).trim().toLowerCase() : undefined,
            branch_id: branchId ? String(branchId).trim() : undefined,
          },
          requester: { id: req?.user?.sub, roles: req?.user?.roles ?? [] },
        },
      )
      .pipe(timeout(8000));
  }

  @Get('post/new')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List new posts' })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    description: 'Region name search',
  })
  getNewPosts(
    @Query('search') search?: string,
    @Req() req?: { user?: JwtUser },
  ) {
    return this.logisticsClient
      .send(
        { cmd: 'logistics.post.new' },
        {
          requester: { id: req?.user?.sub, roles: req?.user?.roles ?? [] },
          query: {
            search,
          },
        },
      )
      .pipe(timeout(8000));
  }

  @Get('post/rejected')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List rejected posts' })
  getRejectedPosts(@Req() req?: { user?: JwtUser }) {
    return this.logisticsClient
      .send(
        { cmd: 'logistics.post.rejected' },
        {
          requester: {
            id: req?.user?.sub,
            roles: req?.user?.roles ?? [],
            branch_id: req?.user?.branch_id ?? null,
          },
        },
      )
      .pipe(timeout(8000));
  }

  @Get('post/on-the-road')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Courier on-the-road posts' })
  getOnTheRoadPosts(@Req() req: { user: JwtUser }) {
    return this.logisticsClient
      .send(
        { cmd: 'logistics.post.on_the_road' },
        { requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
      )
      .pipe(timeout(8000));
  }

  @Get('post/courier/old-posts')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Courier old posts' })
  getOldPostsForCourier(
    @Query('page') page = '1',
    @Query('limit') limit = '8',
    @Req() req: { user: JwtUser },
  ) {
    return this.logisticsClient
      .send(
        { cmd: 'logistics.post.old_for_courier' },
        {
          page: Number(page),
          limit: Number(limit),
          requester: { id: req.user.sub, roles: req.user.roles ?? [] },
        },
      )
      .pipe(timeout(8000));
  }

  @Get('post/courier/rejected')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Courier rejected posts' })
  getRejectedPostsForCourier(@Req() req: { user: JwtUser }) {
    return this.logisticsClient
      .send(
        { cmd: 'logistics.post.rejected_for_courier' },
        { requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
      )
      .pipe(timeout(8000));
  }

  @Get('post/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.COURIER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get post by id' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  getPostById(@Param('id') id: string, @Req() req?: { user?: JwtUser }) {
    return this.logisticsClient
      .send(
        { cmd: 'logistics.post.find_by_id' },
        {
          id,
          requester: { id: req?.user?.sub, roles: req?.user?.roles ?? [] },
        },
      )
      .pipe(timeout(8000));
  }

  @Delete('post/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete post by id (superadmin only)' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  deletePost(@Param('id') id: string) {
    return this.logisticsClient
      .send({ cmd: 'logistics.post.delete' }, { id })
      .pipe(timeout(8000));
  }

  // ⚠️ REGISTRATOR ataylab YO'Q (xavfsizlik): logistics sendPost na post
  // holatini, na filialni tekshiradi — istalgan filial registratori istalgan
  // pochtani istalgan kuryerga berib, HQ qatorini filial kuryeriga tushirib
  // pul zanjirini buzishi mumkin edi. Frontend bu endpointni chaqirmaydi;
  // registratorlar POST /orders/assign-to-courier (filial tekshiruvi bor) va
  // POST /branches/posts/:postId/dispatch dan foydalanadi.
  //
  // CODE-12 — ishga tushirishda superadmin/admin uchun ham O'CHIQ (410):
  // pochtani filial tekshiruvisiz istalgan kuryerga berardi va tanlanmagan
  // buyurtmalarga RECEIVED yozardi. Logistics'ga umuman yuborilmaydi.
  @Patch('post/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Send post (assign orders to post) — disabled for launch (410)',
  })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  @ApiBody({ type: SendPostRequestDto })
  sendPost(): never {
    throw new GoneException(LEGACY_POST_ROUTE_DISABLED_MESSAGE);
  }

  // CODE-12 — O'CHIQ (410): faqat post.courier_id almashardi, buyurtmalar
  // custody'si (courier_id/holder) eski kuryerda qolardi va sotuvni ikkala
  // kuryer ham tasdiqlay olardi.
  @Patch('post/reassign/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Reassign sent post to another courier — disabled for launch (410)',
  })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  @ApiBody({ type: ReassignPostRequestDto })
  reassignPost(): never {
    throw new GoneException(LEGACY_POST_ROUTE_DISABLED_MESSAGE);
  }

  @Get('post/scan/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.COURIER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get post by scanner' })
  @ApiParam({ name: 'id', description: 'Post QR token' })
  getPostByScan(@Param('id') id: string) {
    return this.logisticsClient
      .send({ cmd: 'logistics.post.find_by_scan' }, { id })
      .pipe(timeout(8000));
  }

  @Post('post/courier/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get couriers by post id' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  getCouriersByPost(@Param('id') id: string) {
    return this.logisticsClient
      .send({ cmd: 'logistics.post.couriers_by_post' }, { id })
      .pipe(timeout(8000));
  }

  @Get('post/orders/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.COURIER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all orders by post id' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  getOrdersByPost(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    return firstValueFrom(
      this.logisticsClient
        .send(
          { cmd: 'logistics.post.orders_by_post' },
          {
            id,
            requester: {
              id: req.user.sub,
              roles: req.user.roles ?? [],
              branch_id: req.user.branch_id ?? null,
            },
          },
        )
        .pipe(timeout(8000)),
    ).then(async (response) =>
      // kH2zZsz3: kuryer pochta buyurtmalari — market tarifi/filial ulushisiz
      // (GET /orders/:id bilan AYNI rol proyeksiyasi).
      projectOrderPayloadForRoles(
        req.user.roles,
        await this.enrichOrdersByPostResponse(response),
      ),
    );
  }

  @Get('post/orders/rejected/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.COURIER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get rejected orders by post id' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  getRejectedOrdersByPost(
    @Param('id') id: string,
    @Req() req?: { user?: JwtUser },
  ) {
    return firstValueFrom(
      this.logisticsClient
        .send(
          { cmd: 'logistics.post.rejected_orders_by_post' },
          {
            id,
            requester: {
              id: req?.user?.sub,
              roles: req?.user?.roles ?? [],
              branch_id: req?.user?.branch_id ?? null,
            },
          },
        )
        .pipe(timeout(8000)),
    ).then(async (response) =>
      // kH2zZsz3: GET /orders/:id bilan AYNI rol proyeksiyasi.
      projectOrderPayloadForRoles(
        req?.user?.roles,
        await this.enrichRejectedOrdersByPostResponse(response),
      ),
    );
  }

  @Post('post/check/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check post order exists by qr token' })
  @ApiParam({ name: 'id', description: 'Order QR token' })
  @ApiBody({ type: PostIdRequestDto })
  checkPost(@Param('id') id: string, @Body() dto: PostIdRequestDto) {
    return this.logisticsClient
      .send({ cmd: 'logistics.post.check' }, { id, dto })
      .pipe(timeout(8000));
  }

  @Post('post/check/cancel/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check canceled post order exists by qr token' })
  @ApiParam({ name: 'id', description: 'Order QR token' })
  @ApiBody({ type: PostIdRequestDto })
  checkCancelPost(@Param('id') id: string, @Body() dto: PostIdRequestDto) {
    return this.logisticsClient
      .send({ cmd: 'logistics.post.check_cancel' }, { id, dto })
      .pipe(timeout(8000));
  }

  @Patch('post/receive/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.BRANCH,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.COURIER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Receive post (branch/courier)' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  @ApiBody({ type: ReceivePostRequestDto })
  receivePost(
    @Param('id') id: string,
    @Body() dto: ReceivePostRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.logisticsClient
      .send(
        { cmd: 'logistics.post.receive' },
        {
          id,
          dto,
          requester: {
            id: req.user.sub,
            roles: req.user.roles ?? [],
            branch_id: req.user.branch_id ?? null,
          },
        },
      )
      .pipe(
        timeout(8000),
        // kH2zZsz3 (tekshiruv #4): javob `data` si — qabul qilingan buyurtma
        // qatorlari (logistics `order.find_by_id` dan XOM). Kuryerga
        // GET /orders/:id bilan AYNI rol proyeksiyasi.
        map((response: unknown) =>
          projectOrderPayloadForRoles(req?.user?.roles, response),
        ),
      );
  }

  @Patch('post/receive/scan/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Receive post with scanner (courier)' })
  @ApiParam({ name: 'id', description: 'Post QR token' })
  receivePostWithScan(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    return this.logisticsClient
      .send(
        { cmd: 'logistics.post.receive_scan' },
        { id, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
      )
      .pipe(timeout(8000));
  }

  @Patch('post/receive/order/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Receive order (courier)' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  receiveOrder(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    return this.logisticsClient
      .send(
        { cmd: 'logistics.post.receive_order' },
        { id, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
      )
      .pipe(timeout(8000));
  }

  @Post('post/cancel')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create canceled post (courier → branch, manager → HQ)',
  })
  @ApiBody({ type: ReceivePostRequestDto })
  createCanceledPost(
    @Body() dto: ReceivePostRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.logisticsClient
      .send(
        { cmd: 'logistics.post.cancel.create' },
        {
          dto,
          requester: {
            id: req.user.sub,
            roles: req.user.roles ?? [],
            branch_id: req.user.branch_id ?? null,
          },
        },
      )
      .pipe(timeout(8000));
  }

  @Post('post/cancel/receive/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Receive canceled post (branch manager or HQ)' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  @ApiBody({ type: ReceivePostRequestDto })
  receiveCanceledPost(
    @Param('id') id: string,
    @Body() dto: ReceivePostRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.sendLogisticsWithTimeout(
      { cmd: 'logistics.post.cancel.receive' },
      {
        id,
        dto,
        requester: {
          id: req.user.sub,
          roles: req.user.roles ?? [],
          branch_id: req.user.branch_id ?? null,
        },
      },
    );
  }

  // Pochta → Qaytarish. MANAGER ham kiradi — doira logistics tomonida:
  // menejer/registrator faqat o'z filiali kuryerlarini, superadmin/admin va HQ
  // registratori HQ kuryerlarini ko'radi va ko'rib chiqadi. `branch_id` JWT
  // dan uzatiladi (resolveScopedBranchId birinchi uni oladi).
  @Get('post/return-requests/list')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'List courier return requests grouped by courier (SA/admin/HQ registrator: HQ couriers; manager/registrator: own-branch couriers)',
  })
  async getReturnRequests(@Req() req: { user: JwtUser }) {
    const response = (await this.sendLogisticsWithTimeout(
      { cmd: 'logistics.post.return_requests' },
      {
        requester: {
          id: req.user.sub,
          roles: req.user.roles ?? [],
          branch_id: req.user.branch_id ?? null,
        },
      },
    )) as ReturnRequestsResponse;
    return this.enrichReturnRequestsResponse(response);
  }

  @Post('post/return-requests/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Approve courier return requests: orders go back to the custody stock (own branch for manager/registrator, HQ for SA/admin/HQ registrator)',
  })
  @ApiBody({ type: ReturnRequestsActionRequestDto })
  approveReturnRequests(
    @Body() dto: ReturnRequestsActionRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.sendLogisticsWithTimeout(
      { cmd: 'logistics.post.return_requests.approve' },
      {
        dto,
        requester: {
          id: req.user.sub,
          roles: req.user.roles ?? [],
          branch_id: req.user.branch_id ?? null,
        },
      },
    );
  }

  @Post('post/return-requests/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MANAGER,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Reject courier return requests: orders stay with the courier (same scope as approve)',
  })
  @ApiBody({ type: ReturnRequestsActionRequestDto })
  rejectReturnRequests(
    @Body() dto: ReturnRequestsActionRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.sendLogisticsWithTimeout(
      { cmd: 'logistics.post.return_requests.reject' },
      {
        dto,
        requester: {
          id: req.user.sub,
          roles: req.user.roles ?? [],
          branch_id: req.user.branch_id ?? null,
        },
      },
    );
  }

  // ---------- Region ----------
  @Get('region')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
    RoleEnum.COURIER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all regions' })
  @ApiOkResponse({ description: 'Region list' })
  getAllRegions() {
    return this.sendLogisticsWithTimeout(
      { cmd: 'logistics.region.find_all' },
      {},
    );
  }

  // RBAC-14 — MARKET YO'Q: tashqi marketga kompaniya daromadi (hudud
  // bo'yicha) ko'rinmasin; market panelida hududlar sahifasi yo'q. COURIER
  // qoladi: kuryerning /regions sahifasi shu agregatlarni o'qiydi (bu javobda
  // kuryer ism/telefoni yo'q). (dzyVftBx) LOGIST — viloyatlar ustidan nazorat
  // qiluvchi xodim, hudud statistikasini ko'radi (BeePost bilan bir xil).
  @Get('region/stats/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.COURIER,
    RoleEnum.LOGIST,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all region stats' })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    description: 'YYYY-MM-DD or ISO date-time',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    description: 'YYYY-MM-DD or ISO date-time',
  })
  getAllRegionStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.logisticsClient
      .send({ cmd: 'logistics.region.stats_all' }, { startDate, endDate })
      .pipe(timeout(8000));
  }

  // RBAC-14 — MARKET va COURIER YO'Q: bu javobda HAR BIR kuryerning ismi,
  // telefoni va daromadi bor. Frontend kuryer uchun bu endpointni chaqirmaydi
  // (dashboard hudud kartasi va /regions sahifasining batafsil so'rovi kuryer
  // uchun o'chiq), market paneli esa umuman chaqirmaydi. (dzyVftBx) LOGIST —
  // ichki xodim, viloyat bo'yicha kuryerlar ishini nazorat qiladi (BeePost:
  // stats/:id ADMIN, SUPERADMIN, LOGIST).
  @Get('region/stats/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.LOGIST,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get region detailed stats by id' })
  @ApiParam({ name: 'id', description: 'Region ID (id)' })
  @ApiQuery({
    name: 'startDate',
    required: false,
    type: String,
    description: 'YYYY-MM-DD or ISO date-time',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    type: String,
    description: 'YYYY-MM-DD or ISO date-time',
  })
  getRegionStatsById(
    @Param('id') id: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.logisticsClient
      .send({ cmd: 'logistics.region.stats_by_id' }, { id, startDate, endDate })
      .pipe(timeout(8000));
  }

  @Post('region')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create region' })
  @ApiBody({ type: CreateRegionRequestDto })
  @ApiCreatedResponse({ description: 'Region created' })
  createRegion(@Body() dto: CreateRegionRequestDto) {
    return this.logisticsClient
      .send({ cmd: 'logistics.region.create' }, { dto })
      .pipe(timeout(8000));
  }

  // (dzyVftBx) Statik yo'l — `region/:id` dan OLDIN. BeePost
  // `bulkAssignLogist`: `region_ids` dagi viloyatlar logistga o'tadi, uning
  // boshqa viloyatlaridan u olib tashlanadi. Logist identity'da faol LOGIST
  // ekanini logistics tekshiradi (404/400/503).
  @Post('region/logist/bulk')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Bulk-assign a logist to regions (others of this logist are unassigned)',
  })
  @ApiBody({ type: BulkAssignRegionLogistRequestDto })
  @ApiOkResponse({ description: 'Logist regions replaced' })
  bulkAssignRegionLogist(
    @Body() dto: BulkAssignRegionLogistRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.sendLogisticsWithTimeout(
      { cmd: 'logistics.region.bulk_assign_logist' },
      {
        logist_id: dto.logist_id,
        region_ids: dto.region_ids,
        requester: { id: req.user.sub, roles: req.user.roles ?? [] },
      },
    );
  }

  @Get('region/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
    RoleEnum.COURIER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get region by id' })
  @ApiParam({ name: 'id', description: 'Region ID (id)' })
  getRegionById(@Param('id') id: string) {
    return this.sendLogisticsWithTimeout(
      { cmd: 'logistics.region.find_by_id' },
      { id },
    );
  }

  @Patch('region/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update region' })
  @ApiParam({ name: 'id', description: 'Region ID (id)' })
  @ApiBody({ type: UpdateRegionRequestDto })
  updateRegion(@Param('id') id: string, @Body() dto: UpdateRegionRequestDto) {
    return this.logisticsClient
      .send({ cmd: 'logistics.region.update' }, { id, dto })
      .pipe(timeout(8000));
  }

  // (dzyVftBx) Bitta viloyatga logist biriktirish; `logist_id: null` —
  // olib tashlash (BeePost `assignLogist`).
  @Patch('region/:id/logist')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Assign (or remove with null) a region logist' })
  @ApiParam({ name: 'id', description: 'Region ID (id)' })
  @ApiBody({ type: AssignRegionLogistRequestDto })
  @ApiOkResponse({ description: 'Region logist updated' })
  assignRegionLogist(
    @Param('id') id: string,
    @Body() dto: AssignRegionLogistRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.sendLogisticsWithTimeout(
      { cmd: 'logistics.region.assign_logist' },
      {
        id,
        logist_id: dto.logist_id,
        requester: { id: req.user.sub, roles: req.user.roles ?? [] },
      },
    );
  }

  @Delete('region/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete region' })
  @ApiParam({ name: 'id', description: 'Region ID (id)' })
  deleteRegion(@Param('id') id: string) {
    return this.logisticsClient
      .send({ cmd: 'logistics.region.delete' }, { id })
      .pipe(timeout(15000));
  }

  // ---------- District ----------
  @Get('district')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
    RoleEnum.COURIER,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all districts' })
  @ApiQuery({ name: 'region_id', required: false, type: String })
  @ApiOkResponse({ description: 'District list' })
  getAll(@Query('region_id') region_id?: string) {
    return this.sendLogisticsWithTimeout(
      { cmd: 'logistics.district.find_all' },
      { region_id },
    );
  }

  @Post('district')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create district' })
  @ApiBody({ type: CreateDistrictRequestDto })
  create(@Body() dto: CreateDistrictRequestDto) {
    return this.logisticsClient
      .send({ cmd: 'logistics.district.create' }, { dto })
      .pipe(timeout(8000));
  }

  @Get('district/sato/:satoCode')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.MANAGER,
    RoleEnum.COURIER,
    RoleEnum.MARKET,
    RoleEnum.REGISTRATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get district by sato_code' })
  @ApiParam({ name: 'satoCode', description: 'District SATO code' })
  getDistrictBySato(@Param('satoCode') satoCode: string) {
    return this.logisticsClient
      .send({ cmd: 'logistics.district.find_by_sato' }, { sato_code: satoCode })
      .pipe(timeout(8000));
  }

  @Get('district/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.MANAGER,
    RoleEnum.COURIER,
    RoleEnum.MARKET,
    RoleEnum.REGISTRATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get district by id' })
  @ApiParam({ name: 'id', description: 'District ID (id)' })
  getById(@Param('id') id: string) {
    return this.logisticsClient
      .send({ cmd: 'logistics.district.find_by_id' }, { id })
      .pipe(timeout(8000));
  }

  // LC-08 / RBAC-06 — tumanni boshqa hududga biriktirish HQ intake'da
  // buyurtmalar tushadigan hudud pochtasini butun kompaniya bo'yicha
  // o'zgartiradi. Avval COURIER va MARKET ham ruxsat etilgan edi (nusxa
  // xatosi); endi faqat admin/superadmin — district/name va district/sato
  // bilan bir xil. So'rovchi logistics'ga uzatiladi: u ham rolni tekshiradi
  // va activity log'ga kim o'zgartirganini yozadi.
  @Patch('district/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Assign district to another region' })
  @ApiParam({ name: 'id', description: 'District ID (id)' })
  @ApiBody({ type: UpdateDistrictRequestDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateDistrictRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.logisticsClient
      .send(
        { cmd: 'logistics.district.update' },
        {
          id,
          dto,
          requester: { id: req.user.sub, roles: req.user.roles ?? [] },
        },
      )
      .pipe(timeout(8000));
  }

  @Patch('district/name/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update district name' })
  @ApiParam({ name: 'id', description: 'District ID (id)' })
  @ApiBody({ type: UpdateDistrictNameRequestDto })
  updateName(
    @Param('id') id: string,
    @Body() dto: UpdateDistrictNameRequestDto,
  ) {
    return this.logisticsClient
      .send({ cmd: 'logistics.district.update_name' }, { id, dto })
      .pipe(timeout(8000));
  }

  @Patch('district/sato/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update district sato_code' })
  @ApiParam({ name: 'id', description: 'District ID (id)' })
  @ApiBody({ type: UpdateDistrictSatoCodeRequestDto })
  updateDistrictSato(
    @Param('id') id: string,
    @Body() dto: UpdateDistrictSatoCodeRequestDto,
  ) {
    return this.logisticsClient
      .send({ cmd: 'logistics.district.update_sato' }, { id, dto })
      .pipe(timeout(8000));
  }

  @Get('district/sato-match/preview')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Preview district sato_code matching' })
  previewDistrictSatoMatch() {
    return this.logisticsClient
      .send({ cmd: 'logistics.district.sato_match_preview' }, {})
      .pipe(timeout(8000));
  }

  @Post('district/sato-match/apply')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Apply matched district sato_codes' })
  applyDistrictSatoMatch() {
    return this.logisticsClient
      .send({ cmd: 'logistics.district.sato_match_apply' }, {})
      .pipe(timeout(8000));
  }

  @Delete('district/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Delete district — buyurtma/foydalanuvchi/filial bog'langan bo'lsa 400 (oNAE3LW9)",
  })
  @ApiParam({ name: 'id', description: 'District ID (id)' })
  deleteDistrict(@Param('id') id: string) {
    return this.logisticsClient
      .send({ cmd: 'logistics.district.delete' }, { id })
      .pipe(timeout(15000));
  }

  @Post('district/:id/merge')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      "Tumanni boshqasiga birlashtirish: buyurtma, foydalanuvchi va filiallar ko'chadi, tuman o'chadi (oNAE3LW9)",
    description:
      "Ko'chirishdan OLDIN B dagi sonlar olinadi; keyin A da 0 qolgani va B = eski B + ko'chirilgan ekani tasdiqlanadi. " +
      "Biror bosqich yiqilsa yoki sonlar mos kelmasa — ko'chirilganlar AYNAN o'sha ID'lar bo'yicha A ga qaytariladi, A o'chirilmaydi: " +
      '409 (tekshiruv mos kelmadi / servis rad etdi) yoki 503 (servis javob bermadi). ' +
      "Kompensatsiyaning o'zi yiqilsa — xato matnida qaysi ID'lar qaysi tumanda qolgani yoziladi (to'liq ro'yxat — activity log, " +
      'District #id, action `district.merge_compensation_failed`). ' +
      '200 javobi: `moved` {orders, users, branches}, `target_before`, `target_after`.',
  })
  @ApiParam({ name: 'id', description: "O'chiriladigan tuman ID" })
  @ApiBody({ type: MergeDistrictRequestDto })
  mergeDistrict(@Param('id') id: string, @Body() dto: MergeDistrictRequestDto) {
    // Uch servis bo'ylab ko'chirish + qayta sanash, yiqilsa kompensatsiya
    // (har bosqich 15 s gacha) — eng yomon holat ~110 s.
    return this.logisticsClient
      .send(
        { cmd: 'logistics.district.merge' },
        { id, target_district_id: dto.target_district_id },
      )
      .pipe(timeout(120000));
  }
}
