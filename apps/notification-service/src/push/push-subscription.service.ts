import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { successRes } from '../../../../libs/common/helpers/response';
import {
  PUSH_PLATFORMS,
  PushPlatform,
  PushSubscription,
} from '../entities/push-subscription.entity';
import { WebPushService } from './web-push.service';

export interface SubscribePushInput {
  user_id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  user_agent?: string | null;
  platform?: string | null;
  is_standalone?: boolean | null;
}

export interface UnsubscribePushInput {
  user_id: string;
  endpoint: string;
}

const USER_AGENT_MAX = 256;

const badRequest = (message: string) =>
  new RpcException({ statusCode: 400, message });

const requireText = (value: unknown, field: string): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw badRequest(`${field} is required`);
  return text;
};

/** Obunani saqlash / o'chirish va public kalit (kf0uVbyg). */
@Injectable()
export class PushSubscriptionService {
  constructor(
    @InjectRepository(PushSubscription)
    private readonly repo: Repository<PushSubscription>,
    private readonly webPush: WebPushService,
  ) {}

  /** Faqat PUBLIC kalit qaytadi — private kalit hech bir javobga chiqmaydi. */
  getPublicKey() {
    return successRes({
      enabled: this.webPush.enabled,
      public_key: this.webPush.publicKey,
    });
  }

  /**
   * Idempotent: shu `endpoint` qayta kelsa mavjud qator yangilanadi (id
   * o'zgarmaydi) — `user_id` ham yangilanadi, ya'ni umumiy qurilmada boshqa
   * odam kirsa obuna o'shanga o'tadi, avvalgi egasiga xabar ketmaydi.
   */
  async subscribe(input: SubscribePushInput) {
    if (!this.webPush.enabled) {
      throw new RpcException({
        statusCode: 503,
        message: "Web push serverda o'chiq (VAPID kalitlari sozlanmagan)",
      });
    }

    const userId = requireText(input?.user_id, 'user_id');
    const endpoint = requireText(input?.endpoint, 'endpoint');
    if (!/^https:\/\//i.test(endpoint)) {
      throw badRequest('endpoint must be an https URL');
    }
    const p256dh = requireText(input?.keys?.p256dh, 'keys.p256dh');
    const auth = requireText(input?.keys?.auth, 'keys.auth');
    const platform: PushPlatform = PUSH_PLATFORMS.includes(
      input?.platform as PushPlatform,
    )
      ? (input.platform as PushPlatform)
      : 'desktop';
    const userAgent =
      typeof input?.user_agent === 'string' && input.user_agent.trim()
        ? input.user_agent.trim().slice(0, USER_AGENT_MAX)
        : null;

    await this.repo
      .createQueryBuilder()
      .insert()
      .into(PushSubscription)
      .values({
        user_id: userId,
        endpoint,
        p256dh,
        auth,
        user_agent: userAgent,
        platform,
        is_standalone: input?.is_standalone === true,
        last_used_at: new Date(),
        last_error: null,
      })
      .orUpdate(
        [
          'user_id',
          'p256dh',
          'auth',
          'user_agent',
          'platform',
          'is_standalone',
          'last_used_at',
          'last_error',
          'updated_at',
        ],
        ['endpoint'],
      )
      .execute();

    const saved = await this.repo.findOneOrFail({ where: { endpoint } });
    return successRes(
      {
        id: saved.id,
        platform: saved.platform,
        is_standalone: saved.is_standalone,
      },
      201,
      'Push subscription saved',
    );
  }

  /**
   * Faqat O'Z obunasi o'chadi: begona endpoint ham, mavjud bo'lmagani ham
   * bir xil 404 — kimning endpointi borligi oshkor bo'lmaydi.
   */
  async unsubscribe(input: UnsubscribePushInput) {
    const userId = requireText(input?.user_id, 'user_id');
    const endpoint = requireText(input?.endpoint, 'endpoint');
    const result = await this.repo.delete({ user_id: userId, endpoint });
    if (!result.affected) {
      throw new RpcException({
        statusCode: 404,
        message: 'Push obunasi topilmadi',
      });
    }
    return successRes(
      { deleted: result.affected },
      200,
      'Push subscription removed',
    );
  }
}
