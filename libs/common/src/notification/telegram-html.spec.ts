import { escapeTelegramHtml } from './telegram-html';
import {
  telegramBotApiStub,
  validateTelegramHtml,
} from './telegram-html-kit-spec';

/**
 * OA16fdSq TC9 — `escapeTelegramHtml` (Elchi `parse_mode: HTML`) va spec'lar
 * ishlatadigan Telegram HTML tekshiruvchisi. Tekshiruvchi o'zi ham sinaladi:
 * escape'siz `<`/`&` ni rad etmasa, undan foydalangan testlar hech narsani
 * isbotlamasdi.
 */
describe('escapeTelegramHtml (OA16fdSq TC9)', () => {
  it('`<`, `>`, `&`, `"` → entity; `*`, `_`, `` ` `` (Markdown belgilari) o‘zgarmaydi', () => {
    expect(escapeTelegramHtml('<Ali> & "Vali" *VIP* _x_ `y`')).toBe(
      '&lt;Ali&gt; &amp; &quot;Vali&quot; *VIP* _x_ `y`',
    );
  });

  it('allaqachon escape qilingan matn ikki marta escape qilinadi (Telegram uni aynan ko‘rsatadi)', () => {
    const escaped = escapeTelegramHtml('&lt;b&gt;');
    expect(escaped).toBe('&amp;lt;b&amp;gt;');
    expect(validateTelegramHtml(escaped)).toEqual({
      ok: true,
      plain: '&lt;b&gt;',
    });
  });

  it('null/undefined/obyekt → bo‘sh; son/bool → matn', () => {
    expect(escapeTelegramHtml(null)).toBe('');
    expect(escapeTelegramHtml(undefined)).toBe('');
    expect(escapeTelegramHtml({ toString: () => '<x>' })).toBe('');
    expect(escapeTelegramHtml(42)).toBe('42');
    expect(escapeTelegramHtml(true)).toBe('true');
  });

  it('har qanday foydalanuvchi qiymati escape’dan keyin <b>…</b> ichida Telegram HTML’ga yaroqli va matni yo‘qolmaydi', () => {
    const samples = [
      '<Ali> & *Vali*',
      '</b><i>',
      'A&B',
      '&amp;',
      '&#x1F600;',
      '>>> <<<',
      'O‘g‘il "Qo‘chqor" & Co',
      '*_`[link](tg://x)`_*',
    ];
    for (const sample of samples) {
      const check = validateTelegramHtml(
        `<b>Mijoz:</b> ${escapeTelegramHtml(sample)}`,
      );
      expect(check).toEqual({ ok: true, plain: `Mijoz: ${sample}` });
    }
  });
});

describe('validateTelegramHtml — o‘zi to‘g‘ri rad etadimi (nazorat)', () => {
  it.each([
    ['<b>Mijoz:</b> <Ali> & *Vali*', /Unsupported start tag "ali"/],
    ['<b>Mijoz:</b> Ali & Vali', /unescaped "&"/],
    ['<b>ochiq', /Can't find end tag/],
    ['<b><i>x</b></i>', /Unmatched end tag/],
    ['<script>x</script>', /Unsupported start tag "script"/],
    ['a > b', /unescaped ">"/],
    ['&nbsp;', /unescaped "&"/],
    ['ok \uD83D', /UTF-8/],
    ['<b></b>', /empty/],
  ])('%p — rad etiladi', (text, reason) => {
    const check = validateTelegramHtml(text);
    expect(check.ok).toBe(false);
    expect(!check.ok && check.description).toMatch(reason);
  });

  it('qo‘llanadigan teglar, atributlar va entity’lar qabul qilinadi', () => {
    expect(
      validateTelegramHtml(
        '<b>a</b> <i>b</i> <a href="https://x.uz/?a=1">c</a> <span class="tg-spoiler">d</span> ' +
          '<blockquote expandable>e</blockquote> &lt;&gt;&amp;&quot;&#33;&#x21; 😀',
      ),
    ).toEqual({ ok: true, plain: 'a b c d e <>&"!! 😀' });
  });

  it('emulyator: HTML parse_mode da yaroqsiz matn → 400 can’t parse entities; yaroqli → ok', async () => {
    const api = telegramBotApiStub();
    const send = (body: Record<string, unknown>) =>
      api.fetchImpl('https://bot-api.test/botX/sendMessage', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    const bad = await send({
      chat_id: '-1',
      text: '<Ali>',
      parse_mode: 'HTML',
    });
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        description: expect.stringContaining("can't parse entities"),
      }),
    );
    const good = await send({
      chat_id: '-1',
      text: '&lt;Ali&gt;',
      parse_mode: 'HTML',
    });
    expect(good.status).toBe(200);
    expect(api.calls.map((call) => [call.ok, call.plain])).toEqual([
      [false, undefined],
      [true, '<Ali>'],
    ]);
  });
});
