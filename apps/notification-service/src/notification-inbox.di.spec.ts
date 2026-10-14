import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActivityLogService, OutboxService } from '@app/common';
import { ChannelPlannerService } from './channels/channel-planner.service';
import { Notification } from './entities/notification.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import { PushSubscription } from './entities/push-subscription.entity';
import { NotificationEscalationService } from './escalation/notification-escalation.service';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationServiceService } from './notification-service.service';
import { NotificationPreferencesService } from './preferences/notification-preferences.service';
import { PushDeliveryService } from './push/push-delivery.service';
import { WebPushService } from './push/web-push.service';
import { SmsConfigService } from './sms/sms-config.service';
import { SmsDispatchService } from './sms/sms-dispatch.service';

/**
 * (7Ec56EIw / mP1WGG1W) Nest DI: `@Optional()` planner va eskalatsiya
 * modulda bor bo'lsa HAQIQATAN inject qilinadi (aks holda prod'da jimgina
 * eski xulq — sozlamasiz, eskalatsiyasiz — ishlab ketardi).
 */
describe('NotificationInboxService — DI (planner / escalation)', () => {
  it('ChannelPlannerService va NotificationEscalationService inject qilinadi', async () => {
    const stub = {};
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationInboxService,
        ChannelPlannerService,
        NotificationEscalationService,
        NotificationPreferencesService,
        PushDeliveryService,
        { provide: getRepositoryToken(Notification), useValue: stub },
        { provide: getRepositoryToken(PushSubscription), useValue: stub },
        { provide: getRepositoryToken(NotificationPreference), useValue: stub },
        { provide: 'IDENTITY', useValue: stub },
        { provide: 'GATEWAY', useValue: stub },
        { provide: NotificationServiceService, useValue: stub },
        { provide: ActivityLogService, useValue: stub },
        { provide: SmsDispatchService, useValue: stub },
        { provide: SmsConfigService, useValue: stub },
        { provide: WebPushService, useValue: stub },
        { provide: OutboxService, useValue: stub },
        { provide: DataSource, useValue: stub },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();

    const inbox = moduleRef.get(NotificationInboxService);
    expect(inbox['planner']).toBeInstanceOf(ChannelPlannerService);
    expect(inbox['escalation']).toBeInstanceOf(NotificationEscalationService);
    const push = moduleRef.get(PushDeliveryService);
    expect(push['gatewayClient']).toBe(stub);
    expect(push['config']).toBeDefined();
  });
});
