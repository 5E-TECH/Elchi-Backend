import { inspectAnthropicEnv } from './ai-key-check';

describe('inspectAnthropicEnv', () => {
  it("bVeyEuIR #10: ANTROPIC_API_KEY ('H' tushgan) → misnamed, faqat nom qaytadi", () => {
    const res = inspectAnthropicEnv({ ANTROPIC_API_KEY: 'sk-ant-x' });

    expect(res).toEqual({
      state: 'misnamed',
      misnamedKeys: ['ANTROPIC_API_KEY'],
    });
    // Qiymat HECH QACHON qaytmaydi.
    expect(JSON.stringify(res)).not.toContain('sk-ant-x');
  });

  it("kalit ham, o'xshash nom ham yo'q → missing", () => {
    expect(inspectAnthropicEnv({ NODE_ENV: 'test' })).toEqual({
      state: 'missing',
      misnamedKeys: [],
    });
  });

  it.each(['', '   '])(
    "bo'sh kalit (%p) → missing (o'xshash nom bo'lmasa)",
    (value) => {
      expect(inspectAnthropicEnv({ ANTHROPIC_API_KEY: value }).state).toBe(
        'missing',
      );
    },
  );

  it("bo'sh to'g'ri kalit + o'xshash nom → misnamed", () => {
    const res = inspectAnthropicEnv({
      ANTHROPIC_API_KEY: '',
      CLAUDE_API_KEY: 'sk-ant-y',
    });
    expect(res).toEqual({
      state: 'misnamed',
      misnamedKeys: ['CLAUDE_API_KEY'],
    });
  });

  it("to'g'ri kalit bor → ok (o'xshash nomlar baribir ro'yxatda)", () => {
    const res = inspectAnthropicEnv({
      ANTHROPIC_API_KEY: 'sk-ant-real',
      ANTHROPIC_KEY: 'x',
    });
    expect(res).toEqual({ state: 'ok', misnamedKeys: ['ANTHROPIC_KEY'] });
    expect(JSON.stringify(res)).not.toContain('sk-ant-real');
  });

  it("o'xshash nomlar: ANTHOPIC/ANTOPIC/claude, KEY'siz nom hisobga olinmaydi", () => {
    const res = inspectAnthropicEnv({
      ANTHOPIC_API_KEY: 'a',
      ANTOPIC_API_KEY: 'b',
      claude_api_key: 'c',
      ANTHROPIC_BASE_URL: 'https://example.invalid',
      AI_ORDER_MODEL: 'claude-sonnet-5',
    });
    expect(res.state).toBe('misnamed');
    expect(res.misnamedKeys).toEqual([
      'ANTHOPIC_API_KEY',
      'ANTOPIC_API_KEY',
      'claude_api_key',
    ]);
  });
});
