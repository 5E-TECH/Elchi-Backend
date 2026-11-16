import 'reflect-metadata';
import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ActivityLogModule } from '@app/common';
import { AiUsageModule } from '../usage/ai-usage.module';
import { AdvisorModule } from './advisor.module';

/** ai-service.module'dagi ikki import (ConfigModule.forRoot env talab qiladi). */
@Module({ imports: [AiUsageModule, AdvisorModule] })
class Root {}

/**
 * BE-5 — ai-service modul grafida ActivityLogModule YAGONA nusxa.
 *
 * Nest 11 dinamik modullarni REFERENCE bo'yicha ajratadi (sukut
 * `moduleIdGeneratorAlgorithm` — deep-hash emas): `forService()` ikki joyda
 * chaqirilsa ikki modul, ikki `ActivityLogRetentionScheduler` (ikki cron)
 * bo'ladi. Shu spec grafdagi alohida ActivityLogModule obyektlarini sanaydi.
 */
type ModuleRef = Type<unknown> | DynamicModule | Promise<DynamicModule>;

function collect(root: ModuleRef): Set<unknown> {
  const found = new Set<unknown>();
  const seen = new Set<unknown>();
  const visit = (mod: ModuleRef | undefined): void => {
    if (!mod || mod instanceof Promise || seen.has(mod)) return;
    seen.add(mod);
    const isDynamic = typeof mod === 'object' && 'module' in mod;
    const cls = isDynamic ? mod.module : mod;
    if (cls === ActivityLogModule) found.add(mod);
    const own = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, cls) ??
      []) as ModuleRef[];
    const extra = isDynamic ? ((mod.imports ?? []) as ModuleRef[]) : [];
    for (const child of [...own, ...extra]) visit(child);
  };
  visit(root);
  return found;
}

describe('advisor + usage modul grafi (BE-5)', () => {
  it('ActivityLogModule.forService faqat bir marta (bitta retention cron)', () => {
    expect(collect(Root).size).toBe(1);
  });
});
