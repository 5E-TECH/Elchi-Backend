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
import { CreateBranchRequestDto, UpdateBranchRequestDto } from './dto/branch.swagger.dto';

@ApiTags('Branch')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class BranchGatewayController {
  constructor(@Inject('BRANCH') private readonly branchClient: ClientProxy) {}

  @Post('branches')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Create branch' })
  @ApiBody({ type: CreateBranchRequestDto })
  createBranch(@Body() dto: CreateBranchRequestDto) {
    return this.branchClient.send({ cmd: 'branch.create' }, { dto });
  }

  @Get('branches')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'List branches (pagination + search + status)' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'inactive'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  findAllBranches(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.branchClient.send(
      { cmd: 'branch.find_all' },
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

  @Get('branches/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Find branch by id' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  findBranchById(@Param('id') id: string) {
    return this.branchClient.send({ cmd: 'branch.find_by_id' }, { id });
  }

  @Patch('branches/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Update branch' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  @ApiBody({ type: UpdateBranchRequestDto })
  updateBranch(@Param('id') id: string, @Body() dto: UpdateBranchRequestDto) {
    return this.branchClient.send({ cmd: 'branch.update' }, { id, dto });
  }

  @Delete('branches/:id')
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete branch (soft delete)' })
  @ApiParam({ name: 'id', description: 'Branch ID (bigint string)' })
  deleteBranch(@Param('id') id: string) {
    return this.branchClient.send({ cmd: 'branch.delete' }, { id });
  }
}

