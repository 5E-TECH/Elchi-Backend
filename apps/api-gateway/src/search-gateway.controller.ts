import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from './auth/jwt-auth.guard';

@ApiTags('Search')
@Controller('search')
export class SearchGatewayController {
  constructor(@Inject('SEARCH') private readonly searchClient: ClientProxy) {}

  @Get('health')
  @ApiOperation({ summary: 'Search service health check' })
  health() {
    return this.searchClient.send({ cmd: 'search.health' }, {});
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Global search' })
  @ApiQuery({ name: 'q', required: false, type: String })
  @ApiQuery({ name: 'type', required: false, type: String })
  @ApiQuery({ name: 'source', required: false, type: String })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  query(
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('source') source?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.searchClient.send(
      { cmd: 'search.query' },
      {
        q,
        type,
        source,
        page: page ? Number(page) : undefined,
        limit: limit ? Number(limit) : undefined,
      },
    );
  }
}
