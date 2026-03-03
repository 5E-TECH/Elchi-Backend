import {
  Body,
  Controller,
  Delete,
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
import {
  ApiCreatedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CreateRegionRequestDto,
  CreatePostRequestDto,
  CreateDistrictRequestDto,
  PostIdRequestDto,
  ReceivePostRequestDto,
  SendPostRequestDto,
  UpdateRegionRequestDto,
  UpdateDistrictNameRequestDto,
  UpdateDistrictRequestDto,
} from './dto/logistics.swagger.dto';

interface JwtUser {
  sub: string;
  roles?: string[];
}

@ApiTags('Logistics')
@Controller()
export class LogisticsGatewayController {
  constructor(@Inject('LOGISTICS') private readonly logisticsClient: ClientProxy) {}

  @Get('health')
  @ApiOperation({ summary: 'Logistics service health check' })
  health() {
    return this.logisticsClient.send({ cmd: 'logistics.health' }, {});
  }

  // ---------- Post ----------
  @Get('post')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR, RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all posts (with pagination)' })
  getAllPosts(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.find_all' },
      { query: { page: page ? Number(page) : 1, limit: limit ? Number(limit) : 8 } },
    );
  }

  @Get('post/new')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List new posts' })
  getNewPosts() {
    return this.logisticsClient.send({ cmd: 'logistics.post.new' }, {});
  }

  @Get('post/rejected')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List rejected posts' })
  getRejectedPosts() {
    return this.logisticsClient.send({ cmd: 'logistics.post.rejected' }, {});
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
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR, RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get post by id' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  getPostById(@Param('id') id: string) {
    return this.logisticsClient.send({ cmd: 'logistics.post.find_by_id' }, { id });
  }

  @Patch('post/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send post (assign orders to post)' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  @ApiBody({ type: SendPostRequestDto })
  sendPost(@Param('id') id: string, @Body() dto: SendPostRequestDto) {
    return this.logisticsClient.send({ cmd: 'logistics.post.update' }, { id, dto });
  }

  @Get('post/scan/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR, RoleEnum.COURIER)
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
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR, RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all orders by post id' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  getOrdersByPost(@Param('id') id: string, @Req() req: { user: JwtUser }) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.orders_by_post' },
      { id, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
    );
  }

  @Get('post/orders/rejected/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR, RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get rejected orders by post id' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  getRejectedOrdersByPost(@Param('id') id: string) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.rejected_orders_by_post' },
      { id },
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
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Receive post (courier)' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  @ApiBody({ type: ReceivePostRequestDto })
  receivePost(
    @Param('id') id: string,
    @Body() dto: ReceivePostRequestDto,
    @Req() req: { user: JwtUser },
  ) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.receive' },
      { id, dto, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
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
  @Roles(RoleEnum.COURIER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create canceled post (courier)' })
  @ApiBody({ type: ReceivePostRequestDto })
  createCanceledPost(@Body() dto: ReceivePostRequestDto, @Req() req: { user: JwtUser }) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.cancel.create' },
      { dto, requester: { id: req.user.sub, roles: req.user.roles ?? [] } },
    );
  }

  @Post('post/cancel/receive/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Receive canceled post (admin)' })
  @ApiParam({ name: 'id', description: 'Post ID (id)' })
  @ApiBody({ type: ReceivePostRequestDto })
  receiveCanceledPost(@Param('id') id: string, @Body() dto: ReceivePostRequestDto) {
    return this.logisticsClient.send(
      { cmd: 'logistics.post.cancel.receive' },
      { id, dto },
    );
  }

  @Post('post')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.REGISTRATOR)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create post manually' })
  @ApiBody({ type: CreatePostRequestDto })
  createPost(@Body() dto: CreatePostRequestDto) {
    return this.logisticsClient.send({ cmd: 'logistics.post.create' }, { dto });
  }

  // ---------- Region ----------
  @Get('region')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
    RoleEnum.COURIER,
    RoleEnum.OPERATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all regions' })
  @ApiOkResponse({ description: 'Region list' })
  getAllRegions() {
    return this.logisticsClient.send({ cmd: 'logistics.region.find_all' }, {});
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
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
    RoleEnum.COURIER,
    RoleEnum.OPERATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get region by id' })
  @ApiParam({ name: 'id', description: 'Region ID (id)' })
  getRegionById(@Param('id') id: string) {
    return this.logisticsClient.send({ cmd: 'logistics.region.find_by_id' }, { id });
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
    RoleEnum.REGISTRATOR,
    RoleEnum.MARKET,
    RoleEnum.COURIER,
    RoleEnum.OPERATOR,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all districts' })
  @ApiOkResponse({ description: 'District list' })
  getAll() {
    return this.logisticsClient.send({ cmd: 'logistics.district.find_all' }, {});
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

  @Get('district/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    RoleEnum.ADMIN,
    RoleEnum.SUPERADMIN,
    RoleEnum.COURIER,
    RoleEnum.MARKET,
    RoleEnum.OPERATOR,
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
