import {
  Body,
  Controller,
  Delete,
  GatewayTimeoutException,
  Get,
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
import { firstValueFrom, TimeoutError, timeout } from 'rxjs';
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
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CreateRegionRequestDto,
  CreateDistrictRequestDto,
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
    const marketIds = Array.from(new Set(rows.map((row) => row.market_id).filter(Boolean) as string[]));
    const customerIds = Array.from(new Set(rows.map((row) => row.customer_id).filter(Boolean) as string[]));
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
      market: row.market_id ? marketMap.get(row.market_id) ?? null : null,
      customer: row.customer_id ? customerMap.get(row.customer_id) ?? null : null,
      district: row.district_id ? districtMap.get(row.district_id) ?? null : null,
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

  @Get('health')
  @ApiOperation({ summary: 'Logistics service health check' })
  health() {
    return this.logisticsClient.send({ cmd: 'logistics.health' }, {});
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
    return this.logisticsClient.send(
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
    );
  }

  @Get('post/new')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List new posts' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Region name search' })
  getNewPosts(@Query('search') search?: string, @Req() req?: { user?: JwtUser }) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.new' },
      {
        requester: { id: req?.user?.sub, roles: req?.user?.roles ?? [] },
        query: {
          search,
        },
      },
    );
  }

  @Get('post/rejected')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.BRANCH, RoleEnum.MANAGER, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List rejected posts' })
  getRejectedPosts(@Req() req?: { user?: JwtUser }) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.rejected' },
      { requester: { id: req?.user?.sub, roles: req?.user?.roles ?? [] } },
    );
  }

  @Get('post/on-the-road')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Courier on-the-road posts' })
  getOnTheRoadPosts(@Req() req: { user: JwtUser }) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.on_the_road' },
      { requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
    );
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
    return this.logisticsClient.send(
      { cmd: 'logistics.post.old_for_courier' },
      {
        page: Number(page),
        limit: Number(limit),
        requester: { id: req.user.sub, roles: req.user.roles ?? [] },
      },
    );
  }

  @Get('post/courier/rejected')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Courier rejected posts' })
  getRejectedPostsForCourier(@Req() req: { user: JwtUser }) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.rejected_for_courier' },
      { requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
    );
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
    return this.logisticsClient.send(
      { cmd: 'logistics.post.find_by_id' },
      { id, requester: { id: req?.user?.sub, roles: req?.user?.roles ?? [] } },
    );
  }

  @Delete('post/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete post by id (superadmin only)' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  deletePost(@Param('id') id: string) {
    return this.logisticsClient.send({ cmd: 'logistics.post.delete' }, { id });
  }

  @Patch('post/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send post (assign orders to post)' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  @ApiBody({ type: SendPostRequestDto })
  sendPost(
    @Param('id') id: string,
    @Body() dto: SendPostRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.update' },
      { id, dto, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
    );
  }

  @Patch('post/reassign/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reassign sent post to another courier' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  @ApiBody({ type: ReassignPostRequestDto })
  reassignPost(@Param('id') id: string, @Body() dto: ReassignPostRequestDto) {
    return this.logisticsClient.send({ cmd: 'logistics.post.reassign' }, { id, dto });
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
    return this.logisticsClient.send({ cmd: 'logistics.post.find_by_scan' }, { id });
  }

  @Post('post/courier/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get couriers by post id' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  getCouriersByPost(@Param('id') id: string) {
    return this.logisticsClient.send({ cmd: 'logistics.post.couriers_by_post' }, { id });
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
    ).then((response) => this.enrichOrdersByPostResponse(response));
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
  getRejectedOrdersByPost(@Param('id') id: string, @Req() req?: { user?: JwtUser }) {
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
    ).then((response) => this.enrichRejectedOrdersByPostResponse(response));
  }

  @Post('post/check/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check post order exists by qr token' })
  @ApiParam({ name: 'id', description: 'Order QR token' })
  @ApiBody({ type: PostIdRequestDto })
  checkPost(@Param('id') id: string, @Body() dto: PostIdRequestDto) {
    return this.logisticsClient.send({ cmd: 'logistics.post.check' }, { id, dto });
  }

  @Post('post/check/cancel/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check canceled post order exists by qr token' })
  @ApiParam({ name: 'id', description: 'Order QR token' })
  @ApiBody({ type: PostIdRequestDto })
  checkCancelPost(@Param('id') id: string, @Body() dto: PostIdRequestDto) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.check_cancel' },
      { id, dto },
    );
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
    return this.logisticsClient.send(
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
    );
  }

  @Patch('post/receive/scan/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Receive post with scanner (courier)' })
  @ApiParam({ name: 'id', description: 'Post QR token' })
  receivePostWithScan(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.receive_scan' },
      { id, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
    );
  }

  @Patch('post/receive/order/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Receive order (courier)' })
  @ApiParam({ name: 'id', description: 'Order ID (id)' })
  receiveOrder(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.receive_order' },
      { id, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
    );
  }

  @Post('post/cancel')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.COURIER, RoleEnum.MANAGER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create canceled post (courier → branch, manager → HQ)',
  })
  @ApiBody({ type: ReceivePostRequestDto })
  createCanceledPost(@Body() dto: ReceivePostRequestDto, @Req() req: { user: JwtUser }) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.cancel.create' },
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

  @Get('post/return-requests/list')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List return requests grouped by courier' })
  getReturnRequests() {
    return this.logisticsClient.send({ cmd: 'logistics.post.return_requests' }, {});
  }

  @Post('post/return-requests/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Approve return requests' })
  @ApiBody({ type: ReturnRequestsActionRequestDto })
  approveReturnRequests(
    @Body() dto: ReturnRequestsActionRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.return_requests.approve' },
      { dto, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
    );
  }

  @Post('post/return-requests/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reject return requests' })
  @ApiBody({ type: ReturnRequestsActionRequestDto })
  rejectReturnRequests(
    @Body() dto: ReturnRequestsActionRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.return_requests.reject' },
      { dto, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
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
    return this.sendLogisticsWithTimeout({ cmd: 'logistics.region.find_all' }, {});
  }

  @Get('region/stats/all')
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
  @ApiOperation({ summary: 'Get all region stats' })
  @ApiQuery({ name: 'startDate', required: false, type: String, description: 'YYYY-MM-DD or ISO date-time' })
  @ApiQuery({ name: 'endDate', required: false, type: String, description: 'YYYY-MM-DD or ISO date-time' })
  getAllRegionStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.logisticsClient.send(
      { cmd: 'logistics.region.stats_all' },
      { startDate, endDate },
    );
  }

  @Get('region/stats/:id')
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
  @ApiOperation({ summary: 'Get region detailed stats by id' })
  @ApiParam({ name: 'id', description: 'Region ID (id)' })
  @ApiQuery({ name: 'startDate', required: false, type: String, description: 'YYYY-MM-DD or ISO date-time' })
  @ApiQuery({ name: 'endDate', required: false, type: String, description: 'YYYY-MM-DD or ISO date-time' })
  getRegionStatsById(
    @Param('id') id: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.logisticsClient.send(
      { cmd: 'logistics.region.stats_by_id' },
      { id, startDate, endDate },
    );
  }

  @Post('region')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create region' })
  @ApiBody({ type: CreateRegionRequestDto })
  @ApiCreatedResponse({ description: 'Region created' })
  createRegion(@Body() dto: CreateRegionRequestDto) {
    return this.logisticsClient.send({ cmd: 'logistics.region.create' }, { dto });
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
    return this.sendLogisticsWithTimeout({ cmd: 'logistics.region.find_by_id' }, { id });
  }

  @Patch('region/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update region' })
  @ApiParam({ name: 'id', description: 'Region ID (id)' })
  @ApiBody({ type: UpdateRegionRequestDto })
  updateRegion(@Param('id') id: string, @Body() dto: UpdateRegionRequestDto) {
    return this.logisticsClient.send({ cmd: 'logistics.region.update' }, { id, dto });
  }

  @Delete('region/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete region' })
  @ApiParam({ name: 'id', description: 'Region ID (id)' })
  deleteRegion(@Param('id') id: string) {
    return this.logisticsClient.send({ cmd: 'logistics.region.delete' }, { id });
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
    return this.sendLogisticsWithTimeout({ cmd: 'logistics.district.find_all' }, { region_id });
  }

  @Post('district')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create district' })
  @ApiBody({ type: CreateDistrictRequestDto })
  create(@Body() dto: CreateDistrictRequestDto) {
    return this.logisticsClient.send({ cmd: 'logistics.district.create' }, { dto });
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
    return this.logisticsClient.send({ cmd: 'logistics.district.find_by_sato' }, { sato_code: satoCode });
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
    return this.logisticsClient.send({ cmd: 'logistics.district.find_by_id' }, { id });
  }

  @Patch('district/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN, RoleEnum.COURIER, RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Assign district to another region' })
  @ApiParam({ name: 'id', description: 'District ID (id)' })
  @ApiBody({ type: UpdateDistrictRequestDto })
  update(@Param('id') id: string, @Body() dto: UpdateDistrictRequestDto) {
    return this.logisticsClient.send({ cmd: 'logistics.district.update' }, { id, dto });
  }

  @Patch('district/name/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update district name' })
  @ApiParam({ name: 'id', description: 'District ID (id)' })
  @ApiBody({ type: UpdateDistrictNameRequestDto })
  updateName(@Param('id') id: string, @Body() dto: UpdateDistrictNameRequestDto) {
    return this.logisticsClient.send(
      { cmd: 'logistics.district.update_name' },
      { id, dto },
    );
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
    return this.logisticsClient.send(
      { cmd: 'logistics.district.update_sato' },
      { id, dto },
    );
  }

  @Get('district/sato-match/preview')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Preview district sato_code matching' })
  previewDistrictSatoMatch() {
    return this.logisticsClient.send({ cmd: 'logistics.district.sato_match_preview' }, {});
  }

  @Post('district/sato-match/apply')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Apply matched district sato_codes' })
  applyDistrictSatoMatch() {
    return this.logisticsClient.send({ cmd: 'logistics.district.sato_match_apply' }, {});
  }

  @Delete('district/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete district' })
  @ApiParam({ name: 'id', description: 'District ID (id)' })
  deleteDistrict(@Param('id') id: string) {
    return this.logisticsClient.send({ cmd: 'logistics.district.delete' }, { id });
  }
}
