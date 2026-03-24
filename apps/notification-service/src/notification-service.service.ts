import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Group_type, rmqSend } from '@app/common';
import { TelegramMarket } from './entities/telegram-market.entity';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { UpdateNotificationDto } from './dto/update-notification.dto';
import { SendNotificationDto } from './dto/send-notification.dto';

@Injectable()
export class NotificationServiceService {
  constructor(
    @InjectRepository(TelegramMarket)
    private readonly tgMarketRepo: Repository<TelegramMarket>,
    private readonly configService: ConfigService,
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  private successRes(data: unknown, code = 200, message = 'success') {
    return {
      statusCode: code,
      message,
      data,
    };
  }

  private toRpcError(error: unknown): never {
    if (error instanceof RpcException) {
      throw error;
    }

    if (error instanceof NotFoundException) {
      throw new RpcException({ statusCode: 404, message: error.message });
    }

    if (error instanceof BadRequestException) {
      throw new RpcException({ statusCode: 400, message: error.message });
    }

    throw new RpcException({
      statusCode: 500,
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }

  private assertBigIntId(value: string | undefined, fieldName: string) {
    if (!value || !/^\d+$/.test(String(value))) {
      throw new BadRequestException(`${fieldName} must be a bigint-like numeric string`);
    }
  }

  private async resolveTelegramMarketTarget(data: {
    id?: string;
    market_id?: string;
    group_type?: Group_type;
  }) {
    if (data.id) {
      this.assertBigIntId(data.id, 'id');
      const byId = await this.tgMarketRepo.findOne({
        where: { id: data.id, isDeleted: false },
      });
      if (!byId) {
        throw new NotFoundException('Telegram market not found');
      }
      return byId;
    }

    if (!data.market_id || !data.group_type) {
      throw new BadRequestException('id OR (market_id + group_type) is required');
    }

    this.assertBigIntId(data.market_id, 'market_id');

    const byMarketType = await this.tgMarketRepo.findOne({
      where: {
        market_id: data.market_id,
        group_type: data.group_type,
        isDeleted: false,
      },
    });

    if (!byMarketType) {
      throw new NotFoundException('Telegram market not found');
    }

    return byMarketType;
  }

  private resolveBotToken(tokenFromPayload?: string | null, tokenFromDb?: string | null) {
    const envToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    const token = tokenFromPayload || tokenFromDb || envToken;

    if (!token) {
      throw new BadRequestException(
        'Telegram bot token is required (payload token, db token, or TELEGRAM_BOT_TOKEN env)',
      );
    }

    return token;
  }

  private async parseGroupTokenText(
    text: string,
  ): Promise<{ market_id: string; group_type: Group_type }> {
    const value = text.trim();
    const withType = /^group_token-(\d+)-(create|cancel)$/i.exec(value);
    if (withType) {
      const [, marketId, groupTypeRaw] = withType;
      const groupType =
        groupTypeRaw.toLowerCase() === Group_type.CANCEL
          ? Group_type.CANCEL
          : Group_type.CREATE;
      return { market_id: marketId, group_type: groupType };
    }

    const simple = /^group_token-(\d+)$/i.exec(value);
    if (simple) {
      return { market_id: simple[1], group_type: Group_type.CREATE };
    }

    // Flexible mode:
    // Accept any `group_token-*` text and try to resolve market/group_type
    // from previously saved token mapping (compatible with old behavior).
    const bySavedToken = await this.tgMarketRepo.findOne({
      where: { token: value, isDeleted: false },
      order: { createdAt: 'DESC' },
    });

    if (bySavedToken) {
      return {
        market_id: bySavedToken.market_id,
        group_type: bySavedToken.group_type,
      };
    }

    throw new BadRequestException(
      "Token format invalid. Use 'group_token-<marketId>' or 'group_token-<marketId>-<group_type>' or previously saved token",
    );
  }

  async connectGroupByTokenText(text: string, groupId: string) {
    try {
      const parsed = await this.parseGroupTokenText(text);
      this.assertBigIntId(parsed.market_id, 'market_id');

      const marketResponse = await rmqSend<any>(
        this.identityClient,
        { cmd: 'identity.market.find_by_id' },
        { id: parsed.market_id },
      ).catch(() => null);

      const market = marketResponse?.data ?? marketResponse ?? null;
      if (!market || !market.id) {
        throw new NotFoundException('Market not found');
      }

      const existsByGroup = await this.tgMarketRepo.findOne({
        where: { group_id: groupId, group_type: parsed.group_type, isDeleted: false },
      });

      if (existsByGroup) {
        throw new BadRequestException('This group is already connected for this group type');
      }

      const existsByMarketType = await this.tgMarketRepo.findOne({
        where: {
          market_id: parsed.market_id,
          group_type: parsed.group_type,
          isDeleted: false,
        },
      });

      if (existsByMarketType) {
        existsByMarketType.group_id = groupId;
        existsByMarketType.token = text;
        const updated = await this.tgMarketRepo.save(existsByMarketType);
        return this.successRes(updated, 200, `${market.name ?? 'Market'} uchun telegram group yangilandi`);
      }

      const created = this.tgMarketRepo.create({
        market_id: parsed.market_id,
        group_id: groupId,
        group_type: parsed.group_type,
        token: text,
      });

      const saved = await this.tgMarketRepo.save(created);
      return this.successRes(saved, 201, `${market.name ?? 'Market'} uchun telegram group ulandi`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Noma’lum xatolik yuz berdi';
      return { message };
    }
  }

  async createTelegramMarket(dto: CreateNotificationDto) {
    try {
      this.assertBigIntId(dto.market_id, 'market_id');

      const existing = await this.tgMarketRepo.findOne({
        where: {
          market_id: dto.market_id,
          group_type: dto.group_type,
          isDeleted: false,
        },
      });

      if (existing) {
        throw new BadRequestException('Telegram market for this market_id and group_type already exists');
      }

      const entity = this.tgMarketRepo.create({
        market_id: dto.market_id,
        group_id: dto.group_id,
        group_type: dto.group_type,
        token: dto.token ?? null,
      });

      const saved = await this.tgMarketRepo.save(entity);
      return this.successRes(saved, 201, 'Telegram market created');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async findAllTelegramMarkets(query?: {
    market_id?: string;
    group_type?: Group_type;
    page?: number;
    limit?: number;
  }) {
    try {
      const page = query?.page && query.page > 0 ? query.page : 1;
      const limit = query?.limit && query.limit > 0 ? query.limit : 20;

      const where: FindOptionsWhere<TelegramMarket> = { isDeleted: false };

      if (query?.market_id) {
        this.assertBigIntId(query.market_id, 'market_id');
        where.market_id = query.market_id;
      }

      if (query?.group_type) {
        where.group_type = query.group_type;
      }

      const [items, total] = await this.tgMarketRepo.findAndCount({
        where,
        order: { createdAt: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      });

      return this.successRes(
        {
          items,
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
          },
        },
        200,
        'Telegram markets',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async updateTelegramMarket(dto: UpdateNotificationDto) {
    try {
      const target = await this.resolveTelegramMarketTarget({
        id: dto.id,
        market_id: dto.market_id,
        group_type: dto.group_type,
      });

      if (dto.market_id !== undefined) {
        this.assertBigIntId(dto.market_id, 'market_id');
        target.market_id = dto.market_id;
      }

      if (dto.group_id !== undefined) {
        target.group_id = dto.group_id;
      }

      if (dto.group_type !== undefined) {
        target.group_type = dto.group_type;
      }

      if (dto.token !== undefined) {
        target.token = dto.token || null;
      }

      const duplicate = await this.tgMarketRepo.findOne({
        where: {
          market_id: target.market_id,
          group_type: target.group_type,
          isDeleted: false,
        },
      });

      if (duplicate && duplicate.id !== target.id) {
        throw new BadRequestException('Telegram market for this market_id and group_type already exists');
      }

      const saved = await this.tgMarketRepo.save(target);
      return this.successRes(saved, 200, 'Telegram market updated');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  async deleteTelegramMarket(data: {
    id?: string;
    market_id?: string;
    group_type?: Group_type;
  }) {
    try {
      const target = await this.resolveTelegramMarketTarget(data);
      target.isDeleted = true;
      await this.tgMarketRepo.save(target);
      return this.successRes({ id: target.id }, 200, 'Telegram market deleted');
    } catch (error) {
      this.toRpcError(error);
    }
  }

  private async sendTelegramMessage(data: {
    token: string;
    group_id: string;
    message: string;
    parse_mode?: string;
    disable_web_page_preview?: boolean;
  }) {
    const response = await fetch(`https://api.telegram.org/bot${data.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: data.group_id,
        text: data.message,
        parse_mode: data.parse_mode,
        disable_web_page_preview: data.disable_web_page_preview,
      }),
    });

    const body = await response.json().catch(() => null);

    if (!response.ok || (body && body.ok === false)) {
      throw new BadRequestException(
        body?.description || `Telegram API error (${response.status})`,
      );
    }

    return body?.result ?? null;
  }

  async sendDirectToGroup(data: {
    group_id: string;
    message: string;
    token?: string | null;
    parse_mode?: string;
    disable_web_page_preview?: boolean;
  }) {
    const resolvedToken = this.resolveBotToken(data.token);
    await this.sendTelegramMessage({
      token: resolvedToken,
      group_id: data.group_id,
      message: data.message,
      parse_mode: data.parse_mode,
      disable_web_page_preview: data.disable_web_page_preview,
    });
    return { success: true };
  }

  async sendNotification(dto: SendNotificationDto) {
    try {
      if (!dto.message?.trim()) {
        throw new BadRequestException('message is required');
      }

      type Target = {
        id?: string;
        market_id?: string;
        group_type?: Group_type;
        group_id: string;
        token?: string | null;
      };

      let targets: Target[] = [];

      if (dto.group_id) {
        targets = [{ group_id: dto.group_id, token: dto.token ?? null }];
      } else if (dto.market_id) {
        this.assertBigIntId(dto.market_id, 'market_id');

        const where: FindOptionsWhere<TelegramMarket> = {
          market_id: dto.market_id,
          isDeleted: false,
        };

        if (dto.group_type) {
          where.group_type = dto.group_type;
        }

        const rows = await this.tgMarketRepo.find({ where });

        if (!rows.length) {
          throw new NotFoundException('Telegram target group not found for market');
        }

        targets = rows.map((row) => ({
          id: row.id,
          market_id: row.market_id,
          group_type: row.group_type,
          group_id: row.group_id,
          token: row.token,
        }));
      } else {
        throw new BadRequestException('group_id or market_id is required');
      }

      const results: Array<{
        id?: string;
        market_id?: string;
        group_type?: Group_type;
        group_id: string;
        ok: boolean;
        error?: string;
      }> = [];

      for (const target of targets) {
        try {
          const resolvedToken = this.resolveBotToken(dto.token, target.token);

          await this.sendTelegramMessage({
            token: resolvedToken,
            group_id: target.group_id,
            message: dto.message,
            parse_mode: dto.parse_mode,
            disable_web_page_preview: dto.disable_web_page_preview,
          });

          results.push({
            id: target.id,
            market_id: target.market_id,
            group_type: target.group_type,
            group_id: target.group_id,
            ok: true,
          });
        } catch (err) {
          results.push({
            id: target.id,
            market_id: target.market_id,
            group_type: target.group_type,
            group_id: target.group_id,
            ok: false,
            error: err instanceof Error ? err.message : 'Failed to send',
          });
        }
      }

      const success = results.filter((item) => item.ok).length;
      const failed = results.length - success;

      return this.successRes(
        {
          total: results.length,
          success,
          failed,
          results,
        },
        200,
        'Notification send result',
      );
    } catch (error) {
      this.toRpcError(error);
    }
  }
}
