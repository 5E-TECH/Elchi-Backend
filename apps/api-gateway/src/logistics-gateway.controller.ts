import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
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
  CreateDistrictRequestDto,
  UpdateRegionRequestDto,
  UpdateDistrictNameRequestDto,
  UpdateDistrictRequestDto,
} from './dto/logistics.swagger.dto';

@ApiTags('Logistics')
@Controller()
export class LogisticsGatewayController {
  constructor(@Inject('LOGISTICS') private readonly logisticsClient: ClientProxy) {}

  @Get('health')
  @ApiOperation({ summary: 'Logistics service health check' })
  health() {
    return this.logisticsClient.send({ cmd: 'logistics.health' }, {});
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
  @ApiParam({ name: 'id', description: 'Region ID (uuid)' })
  getRegionById(@Param('id') id: string) {
    return this.logisticsClient.send({ cmd: 'logistics.region.find_by_id' }, { id });
  }

  @Patch('region/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update region' })
  @ApiParam({ name: 'id', description: 'Region ID (uuid)' })
  @ApiBody({ type: UpdateRegionRequestDto })
  updateRegion(@Param('id') id: string, @Body() dto: UpdateRegionRequestDto) {
    return this.logisticsClient.send({ cmd: 'logistics.region.update' }, { id, dto });
  }

  @Delete('region/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete region' })
  @ApiParam({ name: 'id', description: 'Region ID (uuid)' })
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
  @ApiParam({ name: 'id', description: 'District ID (uuid)' })
  getById(@Param('id') id: string) {
    return this.logisticsClient.send({ cmd: 'logistics.district.find_by_id' }, { id });
  }

  @Patch('district/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN, RoleEnum.COURIER, RoleEnum.MARKET)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Assign district to another region' })
  @ApiParam({ name: 'id', description: 'District ID (uuid)' })
  @ApiBody({ type: UpdateDistrictRequestDto })
  update(@Param('id') id: string, @Body() dto: UpdateDistrictRequestDto) {
    return this.logisticsClient.send({ cmd: 'logistics.district.update' }, { id, dto });
  }

  @Patch('district/name/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.ADMIN, RoleEnum.SUPERADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update district name' })
  @ApiParam({ name: 'id', description: 'District ID (uuid)' })
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
  @ApiParam({ name: 'id', description: 'District ID (uuid)' })
  deleteDistrict(@Param('id') id: string) {
    return this.logisticsClient.send({ cmd: 'logistics.district.delete' }, { id });
  }
}
