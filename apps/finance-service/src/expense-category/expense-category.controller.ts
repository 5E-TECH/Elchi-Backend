import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import { ExpenseCategoryService } from './expense-category.service';

/**
 * Elchi Pochta №1 — kassa xarajatlari kategoriyalari.
 * Gateway: `/finance/cashbox/expense-categories*` (ro'yxat — superadmin,
 * admin, menejer; qo'shish / tahrirlash / o'chirish — faqat superadmin).
 */
@Controller()
export class ExpenseCategoryController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly categories: ExpenseCategoryService,
  ) {}

  @MessagePattern({ cmd: 'finance.cashbox.expense_categories.list' })
  list(
    @Payload() data: { include_deleted?: boolean | string } | undefined,
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.categories.list(data ?? {}),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.expense_categories.create' })
  create(
    @Payload()
    data: {
      name: string;
      description?: string | null;
      sort_order?: number;
      created_by?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.categories.create(data),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.expense_categories.update' })
  update(
    @Payload()
    data: {
      id: string;
      name?: string;
      description?: string | null;
      sort_order?: number;
      updated_by?: string | null;
    },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.categories.update(data),
    );
  }

  @MessagePattern({ cmd: 'finance.cashbox.expense_categories.delete' })
  remove(
    @Payload() data: { id: string; deleted_by?: string | null },
    @Ctx() context: RmqContext,
  ) {
    return executeAndAck(this.rmqService, context, () =>
      this.categories.remove(data),
    );
  }
}
