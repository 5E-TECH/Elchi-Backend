import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SecretCipher,
  isAiAllowedInEnv,
  loadAiKeyMasterSecrets,
  rmqRequesterSigSecret,
} from '@app/common';
import {
  type AiConfigAccessSettings,
  parseWriterIds,
} from './ai-config-requester';

/**
 * «AI kalit va modellar» uchun env sozlamalari — bitta joyda. Master sir
 * fayldan BOOT paytida bir marta o'qiladi (qiymat hech qayerga yozilmaydi;
 * logda faqat manba: file/env/none).
 */
@Injectable()
export class AiConfigEnv {
  private readonly logger = new Logger(AiConfigEnv.name);
  readonly cipher: SecretCipher;

  constructor(private readonly config: ConfigService) {
    let cipher = new SecretCipher({ primary: null });
    try {
      const secrets = loadAiKeyMasterSecrets(process.env);
      cipher = new SecretCipher({
        primary: secrets.primary,
        previous: secrets.previous,
      });
      this.logger.log(
        `AI kalit master siri: ${secrets.source}${secrets.previous ? ' (+previous, rotatsiya)' : ''}`,
      );
    } catch (err) {
      // Joi faylni boot'da tekshiradi; bu yerga yetsa — kalit saqlash o'chiq.
      this.logger.error(
        `AI kalit master sirini o'qib bo'lmadi: ${(err as Error).name}`,
      );
    }
    this.cipher = cipher;
  }

  get appEnv(): string {
    return (this.config.get<string>('APP_ENV') ?? 'production').toLowerCase();
  }

  get uiEnabled(): boolean {
    return this.config.get<boolean>('AI_CONFIG_UI_ENABLED') === true;
  }

  get policyStrict(): boolean {
    return this.config.get<boolean>('AI_MODEL_POLICY_STRICT') !== false;
  }

  get stagingAiDisabled(): boolean {
    return !isAiAllowedInEnv();
  }

  get configQueue(): string {
    return (
      this.config.get<string>('RABBITMQ_AI_CONFIG_QUEUE') || 'ai_config_queue'
    );
  }

  /** Env kaliti (trim). Qiymat FAQAT xotirada; view'da hint/iz. */
  get envKey(): string | null {
    const raw = this.config.get<string>('ANTHROPIC_API_KEY');
    const v = typeof raw === 'string' ? raw.trim() : '';
    return v || null;
  }

  num(name: string, fallback: number): number {
    const v = Number(this.config.get<unknown>(name));
    return Number.isFinite(v) ? v : fallback;
  }

  str(name: string): string | null {
    const v = this.config.get<unknown>(name);
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  }

  access(): AiConfigAccessSettings {
    return {
      appEnv: this.appEnv,
      uiEnabled: this.uiEnabled,
      sigSecret: rmqRequesterSigSecret(),
      configQueue: this.configQueue,
      writerIds: parseWriterIds(this.config.get('AI_CONFIG_WRITER_IDS')),
      stepUpRequired:
        this.config.get<boolean>('AI_CONFIG_STEP_UP_REQUIRED') !== false,
      masterKeyConfigured: this.cipher.configured,
    };
  }
}
