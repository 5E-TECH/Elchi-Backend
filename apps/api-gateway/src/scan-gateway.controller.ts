import {
  Controller,
  Get,
  GatewayTimeoutException,
  Inject,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { firstValueFrom, timeout, TimeoutError } from 'rxjs';
import { JwtAuthGuard } from './auth/jwt-auth.guard';

type ScanResponseType = 'order' | 'batch' | 'post';
interface JwtUser {
  sub: string;
  roles?: string[];
}

@ApiTags('Scan')
@Controller('scan')
export class ScanGatewayController {
  constructor(
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('BRANCH') private readonly branchClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
  ) {}

  private normalizeToken(token: string): string {
    return String(token ?? '').trim();
  }

  private extractPrefix(token: string): string {
    return token.slice(0, 4).toUpperCase();
  }

  private async sendWithTimeout(
    service: 'order' | 'branch' | 'logistics',
    pattern: { cmd: string },
    payload: Record<string, unknown>,
  ) {
    const client =
      service === 'order'
        ? this.orderClient
        : service === 'branch'
          ? this.branchClient
          : this.logisticsClient;

    return firstValueFrom(client.send(pattern, payload).pipe(timeout(8000))).catch((error) => {
      if (error instanceof TimeoutError) {
        throw new GatewayTimeoutException(`${service} service response timeout`);
      }
      throw error;
    });
  }

  private shapeResponse(type: ScanResponseType, response: any) {
    return {
      type,
      data: response?.data ?? response,
    };
  }

  @Get(':token')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Resolve scanned QR token to order/batch/post' })
  @ApiParam({ name: 'token', description: 'QR token (ORD-/BTB-/BTR-/PST- or legacy token)' })
  @ApiOkResponse({
    description: 'Resolved scan result',
    schema: {
      example: {
        type: 'batch',
        data: {
          id: '501',
          qr_code_token: 'BTB-a8c3d4e5',
        },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Topilmadi' })
  async scan(
    @Param('token') token: string,
    @Req() req: { user: JwtUser },
  ) {
    const normalizedToken = this.normalizeToken(token);
    const prefix = this.extractPrefix(normalizedToken);

    if (prefix === 'BTB-' || prefix === 'BTR-') {
      const response = await this.sendWithTimeout(
        'branch',
        { cmd: 'branch.transfer_batch.find_by_token' },
        {
          token: normalizedToken,
          requester: { id: req.user.sub, roles: req.user.roles ?? [] },
        },
      );
      return this.shapeResponse('batch', response);
    }

    if (prefix === 'PST-') {
      const response = await this.sendWithTimeout(
        'logistics',
        { cmd: 'logistics.post.find_by_scan' },
        { id: normalizedToken },
      );
      return this.shapeResponse('post', response);
    }

    // ORD- prefixed and legacy prefixless tokens both resolve as order.
    const response = await this.sendWithTimeout(
      'order',
      { cmd: 'order.find_by_qr' },
      { token: normalizedToken },
    );
    return this.shapeResponse('order', response);
  }
}
