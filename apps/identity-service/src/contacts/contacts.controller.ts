import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { CONTACT_PATTERNS, RmqService, executeAndAck } from '@app/common';
import type { RequesterContext } from '../contracts/user.payloads';
import {
  ContactsService,
  type ProblemContactsInput,
  type UpdateContactSettingsInput,
} from './contacts.service';

/** T7 (QPq2C1co) — aloqa raqamlari RMQ naqshlari (`CONTACT_PATTERNS`). */
@Controller()
export class ContactsController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly contacts: ContactsService,
  ) {}

  private run<T>(context: RmqContext, handler: () => Promise<T> | T) {
    return executeAndAck(this.rmqService, context, handler);
  }

  @MessagePattern({ cmd: CONTACT_PATTERNS.SETTINGS_GET })
  getSettings(
    @Payload() payload: { requester?: RequesterContext },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () =>
      this.contacts.getSettings(payload?.requester),
    );
  }

  @MessagePattern({ cmd: CONTACT_PATTERNS.SETTINGS_UPDATE })
  updateSettings(
    @Payload()
    payload: { dto?: UpdateContactSettingsInput; requester?: RequesterContext },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () =>
      this.contacts.updateSettings(payload?.dto ?? {}, payload?.requester),
    );
  }

  @MessagePattern({ cmd: CONTACT_PATTERNS.RESPONSIBLES_LIST })
  listResponsibles(
    @Payload() payload: { search?: string; requester?: RequesterContext },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () =>
      this.contacts.listResponsibles(payload?.search, payload?.requester),
    );
  }

  @MessagePattern({ cmd: CONTACT_PATTERNS.RESPONSIBLE_BULK })
  bulkAssign(
    @Payload()
    payload: {
      responsible_id?: unknown;
      market_ids?: unknown;
      requester?: RequesterContext;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () =>
      this.contacts.bulkAssign(
        {
          responsible_id: payload?.responsible_id,
          market_ids: payload?.market_ids,
        },
        payload?.requester,
      ),
    );
  }

  @MessagePattern({ cmd: CONTACT_PATTERNS.RESPONSIBLE_SET })
  assignOne(
    @Payload()
    payload: {
      market_id?: unknown;
      responsible_id?: unknown;
      requester?: RequesterContext;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () =>
      this.contacts.assignOne(
        payload?.market_id,
        payload?.responsible_id,
        payload?.requester,
      ),
    );
  }

  @MessagePattern({ cmd: CONTACT_PATTERNS.MY_CONTACTS })
  myContacts(
    @Payload() payload: { user_id?: unknown },
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () => this.contacts.myContacts(payload?.user_id));
  }

  @MessagePattern({ cmd: CONTACT_PATTERNS.PROBLEM_CONTACTS })
  problemContacts(
    @Payload() payload: ProblemContactsInput,
    @Ctx() context: RmqContext,
  ) {
    return this.run(context, () =>
      this.contacts.problemContacts(payload ?? {}),
    );
  }
}
