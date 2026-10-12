import { ConfigService } from '@nestjs/config';
import { SmsProviderAccount } from '../entities/sms-provider-account.entity';
import { SmsProviderAccountsService } from './sms-provider-accounts.service';

describe('SmsProviderAccountsService credentials at rest', () => {
  const rows: SmsProviderAccount[] = [];
  const repo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(
        rows.find((row) =>
          Object.entries(where).every(
            ([key, value]) =>
              (row as unknown as Record<string, unknown>)[key] === value,
          ),
        ),
      ),
    ),
    find: jest.fn(() => Promise.resolve(rows)),
    create: jest.fn((row: SmsProviderAccount) => row),
    save: jest.fn((row: SmsProviderAccount) => {
      rows.push({ ...row, id: '1' });
      return Promise.resolve(rows[rows.length - 1]);
    }),
  };
  const config = {
    get: (key: string) =>
      key === 'SMS_CREDENTIAL_SECRET'
        ? 'a-long-secret-for-sms-provider-account-tests'
        : undefined,
  } as ConfigService;

  beforeEach(() => {
    rows.length = 0;
    jest.clearAllMocks();
  });

  it('encrypts login, password and sender in the saved row, then decrypts for the adapter', async () => {
    const service = new SmsProviderAccountsService(repo as never, config);
    await service.upsert(
      {
        provider: 'eskiz',
        sender_profile: 'default',
        login: 'operator@example.test',
        password: 'test-password',
        sender: 'TEST_SENDER',
      },
      '1',
    );

    expect(JSON.stringify(rows[0])).not.toContain('operator@example.test');
    expect(JSON.stringify(rows[0])).not.toContain('test-password');
    expect(JSON.stringify(rows[0])).not.toContain('TEST_SENDER');
    expect(rows[0].sender_enc).toMatch(/^enc:gcm:/);
    expect(await service.getCredentials('eskiz', 'default')).toMatchObject({
      login: 'operator@example.test',
      password: 'test-password',
      sender: 'TEST_SENDER',
    });
    expect(await service.list()).toEqual([
      expect.objectContaining({ sender: 'TEST_SENDER' }),
    ]);
  });
});
