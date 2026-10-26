import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  AI_IMAGE_STORE,
  AI_IMAGE_SWEEP_INTERVAL_MS,
  AiImageStore,
} from '@app/common/ai/ai-image-store';

/**
 * WHMAIqyo #3 — vaqtinchalik ai-parse rasmlarining TTL'i (1 soat): har 10
 * daqiqada (va ishga tushganda) `ai-tmp/` ostidagi 1 soatdan eski obyektlar
 * o'chiriladi. Odatda rasm ai-service o'qigan zahoti o'chadi; bu — RPC
 * timeout / qayta ishga tushish kabi holatlar uchun zaxira. Saqlov
 * sozlanmagan bo'lsa (null) hech narsa qilmaydi. Xatosi servisni buzmaydi.
 */
@Injectable()
export class AiImageSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiImageSweeper.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Optional()
    @Inject(AI_IMAGE_STORE)
    private readonly store?: AiImageStore | null,
  ) {}

  onModuleInit(): void {
    if (!this.store || this.timer) return;
    void this.sweep();
    this.timer = setInterval(
      () => void this.sweep(),
      AI_IMAGE_SWEEP_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(): Promise<number> {
    if (!this.store) return 0;
    const n = await this.store.sweepExpired();
    if (n > 0) this.logger.log(`ai_image_tmp_swept count=${n}`);
    return n;
  }
}
