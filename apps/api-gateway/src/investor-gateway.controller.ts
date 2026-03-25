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
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Roles as RoleEnum } from '@app/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Roles } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  CalculateProfitDto,
  CreateInvestmentDto,
  CreateInvestorDto,
  CreateProfitShareDto,
  UpdateInvestorDto,
} from './dto/investor.swagger.dto';

@ApiTags('Investor')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class InvestorGatewayController {
  constructor(@Inject('INVESTOR') private readonly investorClient: ClientProxy) {}

  @Post('investors')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create investor' })
  @ApiBody({ type: CreateInvestorDto })
  createInvestor(@Body() dto: CreateInvestorDto) {
    return this.investorClient.send({ cmd: 'investor.create' }, { dto });
  }

  @Get('investors')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List investors (pagination + search + status)' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'inactive'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAllInvestors(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.investorClient.send(
      { cmd: 'investor.find_all' },
      {
        query: {
          search,
          status,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
    );
  }

  @Get('investors/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Find investor by id (with investments/profits)' })
  @ApiParam({ name: 'id' })
  findInvestorById(@Param('id') id: string) {
    return this.investorClient.send({ cmd: 'investor.find_by_id' }, { id });
  }

  @Patch('investors/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Update investor' })
  @ApiParam({ name: 'id' })
  @ApiBody({ type: UpdateInvestorDto })
  updateInvestor(@Param('id') id: string, @Body() dto: UpdateInvestorDto) {
    return this.investorClient.send({ cmd: 'investor.update' }, { id, dto });
  }

  @Delete('investors/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete investor (soft delete)' })
  @ApiParam({ name: 'id' })
  deleteInvestor(@Param('id') id: string) {
    return this.investorClient.send({ cmd: 'investor.delete' }, { id });
  }

  @Post('investments')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create investment' })
  @ApiBody({ type: CreateInvestmentDto })
  createInvestment(@Body() dto: CreateInvestmentDto) {
    return this.investorClient.send({ cmd: 'investor.investment.create' }, { dto });
  }

  @Get('investments')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List investments' })
  @ApiQuery({ name: 'investor_id', required: false, type: String })
  @ApiQuery({ name: 'from_date', required: false, type: String })
  @ApiQuery({ name: 'to_date', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAllInvestments(
    @Query('investor_id') investor_id?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.investorClient.send(
      { cmd: 'investor.investment.find_all' },
      {
        query: {
          investor_id,
          from_date,
          to_date,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
    );
  }

  @Get('investors/:investor_id/investments')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List investments by investor' })
  @ApiParam({ name: 'investor_id' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findInvestmentsByInvestor(
    @Param('investor_id') investor_id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.investorClient.send(
      { cmd: 'investor.investment.find_by_investor' },
      {
        investor_id,
        query: {
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
    );
  }

  @Post('profits')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create profit share manually' })
  @ApiBody({ type: CreateProfitShareDto })
  createProfit(@Body() dto: CreateProfitShareDto) {
    return this.investorClient.send({ cmd: 'investor.profit.create' }, { dto });
  }

  @Post('profits/calculate')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Calculate profit share by period and percentage' })
  @ApiBody({ type: CalculateProfitDto })
  calculateProfit(@Body() dto: CalculateProfitDto) {
    return this.investorClient.send({ cmd: 'investor.profit.calculate' }, { dto });
  }

  @Get('profits')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List profit shares' })
  @ApiQuery({ name: 'investor_id', required: false, type: String })
  @ApiQuery({ name: 'is_paid', required: false, type: String, example: 'true' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAllProfits(
    @Query('investor_id') investor_id?: string,
    @Query('is_paid') is_paid?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.investorClient.send(
      { cmd: 'investor.profit.find_all' },
      {
        query: {
          investor_id,
          is_paid:
            typeof is_paid === 'string'
              ? ['true', '1', 'yes'].includes(is_paid.toLowerCase())
              : undefined,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
    );
  }

  @Get('investors/:investor_id/profits')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List profit shares by investor' })
  @ApiParam({ name: 'investor_id' })
  @ApiQuery({ name: 'is_paid', required: false, type: String, example: 'false' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findProfitByInvestor(
    @Param('investor_id') investor_id: string,
    @Query('is_paid') is_paid?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.investorClient.send(
      { cmd: 'investor.profit.find_by_investor' },
      {
        investor_id,
        query: {
          is_paid:
            typeof is_paid === 'string'
              ? ['true', '1', 'yes'].includes(is_paid.toLowerCase())
              : undefined,
          page: page ? Number(page) : undefined,
          limit: limit ? Number(limit) : undefined,
        },
      },
    );
  }

  @Patch('profits/:id/mark-paid')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Mark profit share as paid' })
  @ApiParam({ name: 'id' })
  markProfitPaid(@Param('id') id: string) {
    return this.investorClient.send({ cmd: 'investor.profit.mark_paid' }, { id });
  }
}
