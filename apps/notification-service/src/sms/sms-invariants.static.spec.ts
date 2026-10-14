import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Statik o'zgarmaslar (kod matni bo'yicha), sVByLMnt:
 * - TC7: SMS modulida `AT TIME ZONE 'Asia/Tashkent'` ATIGI BIR joyda (xarajat
 *   hisoboti); kvota va tungi taqiq yagona `@app/common` tashkent-time qoidasi
 *   orqali — server TZ'iga bog'liq `getHours/setHours`, `timeZone:` yo'q.
 * - TC11: kampaniya segmenti `identity.user.find_all` ni chaqirmaydi va
 *   identity'dagi rol filtri (superadmin/customer chiqariladi) joyida.
 */
const SMS_DIR = __dirname;
const REPO = join(__dirname, '..', '..', '..', '..');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });

/** Izohlarni olib tashlaydi — faqat kod sanaladi. */
const code = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('SMS statik o‘zgarmaslar (sVByLMnt)', () => {
  const files = sourceFiles(SMS_DIR);

  it('TC7: AT TIME ZONE SMS modulida ATIGI BIR marta va faqat Asia/Tashkent', () => {
    const hits = files.flatMap((file) =>
      [...code(file).matchAll(/AT TIME ZONE\s+'([^']+)'/gi)].map((match) => ({
        file: file.slice(SMS_DIR.length + 1),
        zone: match[1],
      })),
    );
    expect(hits).toEqual([
      { file: 'sms-outbox.service.ts', zone: 'Asia/Tashkent' },
    ]);
  });

  it('TC7: server TZ’iga bog‘liq soat hisobi yo‘q (qo‘shaloq konversiya manbai)', () => {
    for (const file of files) {
      expect({
        file,
        bad: code(file).match(
          /\.(get|set)Hours\(|\.getDate\(\)|timeZone\s*:|toLocaleTimeString/g,
        ),
      }).toEqual({ file, bad: null });
    }
  });

  it('TC7: kvota va tungi taqiq bitta umumiy qoidadan (startOfTashkentDay / TASHKENT_OFFSET_MINUTES)', () => {
    const gate = code(join(SMS_DIR, 'sms-gate.service.ts'));
    expect(gate).toMatch(
      /import \{[^}]*startOfTashkentDay[^}]*TASHKENT_OFFSET_MINUTES[^}]*\} from '@app\/common'/,
    );
  });

  it('TC11: segment resolveri identity.user.find_all ni chaqirmaydi; identity rol filtri joyida', () => {
    for (const file of files) {
      expect({
        file,
        hit: code(file).includes('identity.user.find_all'),
      }).toEqual({ file, hit: false });
    }
    const identity = readFileSync(
      join(REPO, 'apps/identity-service/src/user-service.service.ts'),
      'utf8',
    );
    expect(identity).toContain("'admin.role != :superadminRole'");
    expect(identity).toContain("'admin.role != :customerRole'");
  });
});
