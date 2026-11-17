import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PATTERN_METADATA } from '@nestjs/microservices/constants';
import { AI_FAST_PATTERNS } from '@app/common';
import { AiServiceController } from '../ai-service.controller';
import { AiFastRmqServer } from './ai-fast-server';

/**
 * (AI ack B1) TEZ navbat iste'molchisi: faqat arzon DB naqshlari; Claude
 * chaqiradigan naqsh tez navbatda ro'yxatdan o'tmaydi.
 */
describe('AiFastRmqServer (AI ack B1)', () => {
  const server = () =>
    new AiFastRmqServer({ urls: ['amqp://localhost'], queue: 'ai_fast_queue' });

  it('faqat AI_FAST_PATTERNS ro‘yxatdan o‘tadi', () => {
    const s = server();
    const noop = () => Promise.resolve(null);
    for (const cmd of [
      'ai.order.extract',
      'ai.product.disambiguate',
      'ai.assistant.message',
      'ai.draft.trace_by_order',
      ...AI_FAST_PATTERNS,
    ]) {
      s.addHandler({ cmd }, noop);
    }
    const registered = [...s.getHandlers().keys()].map(
      (key) => (JSON.parse(key) as { cmd: string }).cmd,
    );
    expect(registered.sort()).toEqual([...AI_FAST_PATTERNS].sort());
  });

  it('har tez naqshga ai-service controller’da handler bor (eski navbatda ham)', () => {
    const proto = AiServiceController.prototype as unknown as Record<
      string,
      unknown
    >;
    const cmds = Object.getOwnPropertyNames(proto)
      .flatMap((name) => {
        const fn = proto[name];
        if (typeof fn !== 'function') return [];
        const patterns = Reflect.getMetadata(PATTERN_METADATA, fn) as
          { cmd?: string }[] | undefined;
        return (patterns ?? []).map((p) => p.cmd);
      })
      .filter((cmd): cmd is string => typeof cmd === 'string');
    for (const cmd of AI_FAST_PATTERNS) expect(cmds).toContain(cmd);
  });

  it('main.ts ikkinchi iste’molchini (AI_FAST, AI_FAST_PREFETCH) ulaydi', () => {
    const main = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');
    expect(main).toContain('setupDlqTopology(AI_FAST_RMQ_NAME)');
    expect(main).toContain('new AiFastRmqServer(');
    expect(main).toContain("'AI_FAST_PREFETCH'");
    // Eski navbat ham ulanadi (rolling deploy).
    expect(main).toContain("getOptions('AI')");
  });
});
