import { Roles, Status } from '@app/common';
import { UserServiceService } from './user-service.service';

/**
 * td89SKXQ #5 / 4TfLyTrL — umumiy javoblarda (GET /users, GET /users/:id,
 * GET /markets, profil, buyurtmadagi `market` obyekti — hammasi `sanitize`
 * dan o'tadi) `market_tg_token` ham, `telegram_id` ham YO'Q (superadmin
 * uchun ham). O'rniga faqat holat: `telegram_linked`.
 */
describe('td89SKXQ — sanitize: market_tg_token va telegram_id javobda yo‘q', () => {
  const sanitize = (row: Record<string, unknown>) =>
    (
      UserServiceService.prototype as unknown as {
        sanitize: (user: unknown) => Record<string, unknown>;
      }
    ).sanitize.call({}, row);

  const market = {
    id: '37',
    name: 'TEST Claude Market',
    role: Roles.MARKET,
    status: Status.ACTIVE,
    password: 'bcrypt',
    refresh_token: 'sha',
    market_tg_token: 'group_token-0123456789abcdef0123456789abcdef',
    telegram_id: '5550007',
    telegram_username: 'test_market',
  };

  it('⭐ ulangan market — market_tg_token, telegram_id, password, refresh_token yo‘q; telegram_linked: true', () => {
    const safe = sanitize(market);
    for (const key of [
      'market_tg_token',
      'telegram_id',
      'password',
      'refresh_token',
    ]) {
      expect(safe).not.toHaveProperty(key);
    }
    expect(safe.telegram_linked).toBe(true);
    expect(JSON.stringify(safe)).not.toContain('5550007');
    expect(JSON.stringify(safe)).not.toContain('group_token-');
    expect(safe).toEqual(
      expect.objectContaining({ id: '37', name: 'TEST Claude Market' }),
    );
  });

  it('ulanmagan — telegram_linked: false', () => {
    expect(sanitize({ ...market, telegram_id: null }).telegram_linked).toBe(
      false,
    );
  });

  it('telegram_id tanlanmagan proyeksiya — telegram_linked qo‘shilmaydi (noto‘g‘ri "false" yo‘q)', () => {
    const { telegram_id: _omit, ...row } = market;
    void _omit;
    expect(sanitize(row)).not.toHaveProperty('telegram_linked');
  });
});
