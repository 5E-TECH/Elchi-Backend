/**
 * Telegram Bot API `parse_mode: 'HTML'` uchun QAT'IY tekshiruvchi va
 * `sendMessage` emulyatori (OA16fdSq TC8/TC9 spec'lari). Fayl nomi
 * `*-spec.ts` — jest uni test deb yugurtirmaydi, build esa chiqarib tashlaydi.
 *
 * Qoidalar — Bot API hujjati, "HTML style" bo'limi:
 *  • faqat ro'yxatdagi teglar (b, strong, i, em, u, ins, s, strike, del,
 *    span.tg-spoiler, tg-spoiler, a, tg-emoji, code, pre, blockquote);
 *    teglar to'g'ri ichma-ich yopilishi shart;
 *  • teg yoki entity bo'lmagan `<`, `>`, `&` — `&lt;`, `&gt;`, `&amp;` bo'lishi
 *    shart; nomli entity'lardan faqat `&lt; &gt; &amp; &quot;`, raqamlilar
 *    hammasi;
 *  • matn yaroqli UTF-8 (yolg'iz UTF-16 surrogate yo'q), entity'lardan keyingi
 *    uzunlik 1..4096.
 * Tekshiruvchi Telegram'dan QAT'IYROQ (masalan yalang'och `>` ni ham rad
 * etadi): undan o'tgan matnni Telegram ham qabul qiladi.
 */

export type TelegramHtmlCheck =
  | { ok: true; plain: string }
  | { ok: false; description: string };

const ALLOWED_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'span',
  'tg-spoiler',
  'a',
  'tg-emoji',
  'code',
  'pre',
  'blockquote',
]);

const NAMED_ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
};

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const fail = (description: string): TelegramHtmlCheck => ({
  ok: false,
  description: `Bad Request: ${description}`,
});

export function validateTelegramHtml(text: unknown): TelegramHtmlCheck {
  if (typeof text !== 'string') return fail('message text is empty');
  if (LONE_SURROGATE.test(text)) {
    return fail('strings must be encoded in UTF-8');
  }
  const stack: string[] = [];
  let plain = '';
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch === '<') {
      const tag = /^<(\/?)([a-z-]+)((?:\s+[a-z-]+(?:="[^"<>]*")?)*)\s*>/i.exec(
        text.slice(i),
      );
      if (!tag) {
        return fail(
          `can't parse entities: Unsupported start tag at offset ${i}`,
        );
      }
      const [whole, closing, rawName] = tag;
      const name = rawName.toLowerCase();
      if (!ALLOWED_TAGS.has(name)) {
        return fail(
          `can't parse entities: Unsupported start tag "${name}" at offset ${i}`,
        );
      }
      if (closing) {
        const open = stack.pop();
        if (open !== name) {
          return fail(
            `can't parse entities: Unmatched end tag at offset ${i}, expected "</${open ?? ''}>", found "</${name}>"`,
          );
        }
      } else {
        stack.push(name);
      }
      i += whole.length;
      continue;
    }
    if (ch === '>') {
      return fail(
        `can't parse entities: unescaped ">" at offset ${i} (must be &gt;)`,
      );
    }
    if (ch === '&') {
      const entity =
        /^&(?:(lt|gt|amp|quot)|#(\d{1,7})|#x([0-9a-f]{1,6}));/i.exec(
          text.slice(i),
        );
      if (!entity) {
        return fail(
          `can't parse entities: unescaped "&" at offset ${i} (must be &amp;)`,
        );
      }
      const [whole, named, dec, hex] = entity;
      const code = named ? 0 : dec ? Number(dec) : parseInt(hex, 16);
      if (!named && (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))) {
        return fail(`can't parse entities: invalid entity at offset ${i}`);
      }
      plain += named
        ? NAMED_ENTITIES[named.toLowerCase()]
        : String.fromCodePoint(code);
      i += whole.length;
      continue;
    }
    plain += ch;
    i += 1;
  }
  if (stack.length) {
    return fail(
      `can't parse entities: Can't find end tag corresponding to start tag "${stack.at(-1)}"`,
    );
  }
  if (!plain.trim()) return fail('message text is empty');
  if (plain.length > 4096) return fail('message is too long');
  return { ok: true, plain };
}

export interface TelegramApiCall {
  method: string;
  body: Record<string, unknown>;
  /** Emulyator javobi: `ok` — Telegram qabul qildi. */
  ok: boolean;
  description?: string;
  /** HTML'dan keyingi ko'rinadigan matn (qabul qilingan bo'lsa). */
  plain?: string;
}

/**
 * `BotTransportService.fetchImpl` o'rniga — Telegram Bot API emulyatori.
 * `sendMessage` + `parse_mode: 'HTML'` da matn `validateTelegramHtml` dan
 * o'tmasa haqiqiy API kabi `400 Bad Request: can't parse entities` qaytaradi.
 */
export function telegramBotApiStub() {
  const calls: TelegramApiCall[] = [];
  let nextMessageId = 1000;
  const respond = (status: number, body: Record<string, unknown>) =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response);

  const fetchImpl = (url: string, init: RequestInit): Promise<Response> => {
    const method = url.split('/').pop() ?? '';
    const body = JSON.parse(
      typeof init.body === 'string' ? init.body : '{}',
    ) as Record<string, unknown>;
    if (method !== 'sendMessage') {
      calls.push({ method, body, ok: true });
      return respond(200, { ok: true, result: true });
    }
    const check: TelegramHtmlCheck =
      body.parse_mode === 'HTML'
        ? validateTelegramHtml(body.text)
        : typeof body.text === 'string' &&
            body.text.trim() &&
            !LONE_SURROGATE.test(body.text)
          ? { ok: true, plain: body.text }
          : { ok: false, description: 'Bad Request: message text is empty' };
    if (!check.ok) {
      calls.push({ method, body, ok: false, description: check.description });
      return respond(400, {
        ok: false,
        error_code: 400,
        description: check.description,
      });
    }
    calls.push({ method, body, ok: true, plain: check.plain });
    return respond(200, {
      ok: true,
      result: {
        message_id: nextMessageId++,
        chat: { id: Number(body.chat_id) },
        text: check.plain,
      },
    });
  };
  return { fetchImpl, calls };
}
