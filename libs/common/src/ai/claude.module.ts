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

export interface ClaudeModuleOptions {
  /** usageSink / budgetGuard provayderlarini eksport qiladigan modullar. */
  imports?: ModuleMetadata['imports'];
  /** `ClaudeUsageSink` ni amalga oshiruvchi provayder tokeni. */
  usageSink?: InjectionToken;
  /** `ClaudeBudgetGuard` ni amalga oshiruvchi provayder tokeni. */
  budgetGuard?: InjectionToken;
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
    return {
      module: ClaudeModule,
      imports: opts.imports ?? [],
      providers,
      exports: [ClaudeService],
    };
  }
}
