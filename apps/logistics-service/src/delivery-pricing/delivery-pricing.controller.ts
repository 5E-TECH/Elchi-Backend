import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { RmqService, executeAndAck } from '@app/common';
import { DeliveryPricingService } from './delivery-pricing.service';
import {
  DELIVERY_PRICING_PATTERNS,
  type CreateDeliveryTariffPayload,
  type DeliveryPricingRequester,
  type DeliveryQuotePayload,
  type ListDeliveryTariffsPayload,
  type UpdateDeliveryPricingSettingsPayload,
} from './delivery-pricing.types';

/**
 * DAqXPeSy — yetkazish narxi RPC'lari. Rol tekshiruvi gateway'da
 * (`DeliveryPricingGatewayController`): quote — xodimlar + MARKET, qolgani —
 * SUPERADMIN/ADMIN. MARKET uchun mahsulot egaligi servisda tekshiriladi.
 */
@Controller()
export class DeliveryPricingController {
  constructor(
    private readonly rmqService: RmqService,
    private readonly pricing: DeliveryPricingService,
  ) {}

  private executeAndAck<T>(context: RmqContext, handler: () => Promise<T> | T) {
    return executeAndAck(this.rmqService, context, handler);
  }

  @MessagePattern({ cmd: DELIVERY_PRICING_PATTERNS.QUOTE })
  quote(@Payload() payload: DeliveryQuotePayload, @Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.pricing.quote(payload));
  }

  @MessagePattern({ cmd: DELIVERY_PRICING_PATTERNS.TARIFFS_FIND_ALL })
  listTariffs(
    @Payload() payload: ListDeliveryTariffsPayload,
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.pricing.listTariffs(payload ?? {}),
    );
  }

  @MessagePattern({ cmd: DELIVERY_PRICING_PATTERNS.TARIFFS_CREATE })
  createTariff(
    @Payload()
    payload: {
      dto: CreateDeliveryTariffPayload;
      requester?: DeliveryPricingRequester;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.pricing.createTariff(payload?.dto, payload?.requester),
    );
  }

  @MessagePattern({ cmd: DELIVERY_PRICING_PATTERNS.SETTINGS_GET })
  getSettings(@Ctx() context: RmqContext) {
    return this.executeAndAck(context, () => this.pricing.getSettings());
  }

  @MessagePattern({ cmd: DELIVERY_PRICING_PATTERNS.SETTINGS_UPDATE })
  updateSettings(
    @Payload()
    payload: {
      dto: UpdateDeliveryPricingSettingsPayload;
      requester?: DeliveryPricingRequester;
    },
    @Ctx() context: RmqContext,
  ) {
    return this.executeAndAck(context, () =>
      this.pricing.updateSettings(payload?.dto, payload?.requester),
    );
  }
}
