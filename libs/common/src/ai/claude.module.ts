import {
  DynamicModule,
  InjectionToken,
  Module,
  ModuleMetadata,
  Provider,
} from '@nestjs/common';
import {
  ANTHROPIC_CLIENT_FACTORY,
  CLAUDE_BUDGET_GUARD,
  CLAUDE_USAGE_SINK,
} from './claude.constants';
import { ClaudeService, defaultAnthropicClientFactory } from './claude.service';
import { ANTHROPIC_CLIENT_PROVIDER } from './anthropic-client.provider';

export interface ClaudeModuleOptions {
  /** usageSink / budgetGuard provayderlarini eksport qiladigan modullar. */
  imports?: ModuleMetadata['imports'];
  /** `ClaudeUsageSink` ni amalga oshiruvchi provayder tokeni. */
  usageSink?: InjectionToken;
  /** `ClaudeBudgetGuard` ni amalga oshiruvchi provayder tokeni. */
  budgetGuard?: InjectionToken;
  /**
   * «AI kalit va modellar»: `AnthropicClientProvider` (UI > env > yo'q).
   * Berilmasa — env provayderi (bugungi xulq).
   */
  clientProvider?: InjectionToken;
}

/**
 * ClaudeService'ni ulaydigan modul.
 *
 * ⚠️ FAQAT apps/ai-service import qiladi — ANTHROPIC_API_KEY faqat o'sha
 * konteynerda. ConfigService global (`ConfigModule.forRoot({isGlobal:true})`)
 * deb hisoblanadi — boshqa lib modullari (RmqModule, DatabaseModule) kabi.
 *
 * Misol:
 *   ClaudeModule.forRoot({
 *     imports: [AiUsageModule],
 *     usageSink: AiUsageService,
 *     budgetGuard: AiBudgetService,
 *   })
 */
@Module({})
export class ClaudeModule {
  static forRoot(opts: ClaudeModuleOptions = {}): DynamicModule {
    const providers: Provider[] = [
      {
        provide: ANTHROPIC_CLIENT_FACTORY,
        useValue: defaultAnthropicClientFactory,
      },
      ClaudeService,
    ];
    // Portlar faqat berilganda ulanadi — aks holda ClaudeService ularsiz
    // (@Optional) ishlaydi.
    if (opts.usageSink) {
      providers.push({
        provide: CLAUDE_USAGE_SINK,
        useExisting: opts.usageSink,
      });
    }
    if (opts.budgetGuard) {
      providers.push({
        provide: CLAUDE_BUDGET_GUARD,
        useExisting: opts.budgetGuard,
      });
    }
    if (opts.clientProvider) {
      providers.push({
        provide: ANTHROPIC_CLIENT_PROVIDER,
        useExisting: opts.clientProvider,
      });
    }
    return {
      module: ClaudeModule,
      imports: opts.imports ?? [],
      providers,
      exports: [ClaudeService],
    };
  }
}
