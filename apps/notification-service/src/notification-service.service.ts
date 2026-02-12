import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramMarket } from './entities/telegram-market.entity';

@Injectable()
export class NotificationServiceService {
  constructor(
    @InjectRepository(TelegramMarket) private readonly tgMarketRepo: Repository<TelegramMarket>,
  ) {}

  // TODO: TelegramMarket CRUD
  // TODO: Send notification via Telegram bot
  // TODO: Push notification
}
