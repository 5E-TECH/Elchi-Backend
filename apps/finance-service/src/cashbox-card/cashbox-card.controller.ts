import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import {
  CashboxCardService,
  type CardCashboxScope,
  type CardDetailsInput,
} from './cashbox-card.service';
import type { CardMovementType } from '../entities/cashbox-card-movement.entity';

/**
 * 3PE0B03q — kassa nomli kartalari (BeePost `cashbox_card` porti).
 * Gateway: `/finance/cashbox/cards*` (CRUD — superadmin, admin; Zv3MLn0a:
 * o'qish — menejer ham, faqat o'z filiali kassasi: payload `branch_id`).
 */
@Controller()
export class CashboxCardController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly cards: CashboxCardService,
  ) {}

  @MessagePattern({ cmd: 'finance.cashbox.cards.list' })
  list(
    @Payload()
    data:
      | ({ include_inactive?: boolean | string } & CardCashboxScope)
      | undefined,
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.cards.listCards(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.cards.create' })
  create(
    @Payload()
    data: {
      name: string;
      sort_order?: number;
      created_by?: string | null;
      make_default?: boolean;
    } & CardDetailsInput &
      CardCashboxScope,
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.cards.createCard(data),
    );
  }

  /** Zv3MLn0a — nom + tafsilotlar (Asosiy kartada ham; nomi — 400). */
  @MessagePattern({ cmd: 'finance.cashbox.cards.update' })
  update(
    @Payload()
    data: {
      id: string;
      name?: string;
      sort_order?: number;
      updated_by?: string | null;
    } & CardDetailsInput &
      CardCashboxScope,
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.cards.updateCard(data),
    );
  }

  /** Zv3MLn0a — kartani kassaning Asosiy kartasi qilish (kassa qulfi ostida). */
  @MessagePattern({ cmd: 'finance.cashbox.cards.make_default' })
  makeDefault(
    @Payload()
    data: { id: string; updated_by?: string | null } & CardCashboxScope,
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.cards.makeDefault(data),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.cards.rename' })
  rename(
    @Payload() data: { id: string; name: string; updated_by?: string | null },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.cards.renameCard(data),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.cards.set_active' })
  setActive(
    @Payload()
    data: { id: string; is_active: boolean; updated_by?: string | null },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.cards.setCardActive(data),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.cards.transfer' })
  transfer(
    @Payload()
    data: {
      from_card_id: string;
      to_card_id: string;
      amount: number;
      comment: string;
      created_by?: string | null;
      dedup_epoch?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.cards.transfer(data),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.cards.convert' })
  convert(
    @Payload()
    data: {
      type: CardMovementType;
      card_id: string;
      amount: number;
      comment: string;
      created_by?: string | null;
      dedup_epoch?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.cards.convert(data),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.cards.movements' })
  movements(
    @Payload()
    data:
      | ({ card_id?: string; page?: number; limit?: number } & CardCashboxScope)
      | undefined,
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.cards.listMovements(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.cards.ledger' })
  ledger(
    @Payload()
    data: {
      id: string;
      from_date?: string;
      to_date?: string;
      page?: number;
      limit?: number;
      all?: boolean;
    } & CardCashboxScope,
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.cards.getLedger(data),
    );
  }
}
