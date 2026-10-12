import { QueryRunner } from 'typeorm';
import { EncryptSmsSender1716000000068 } from '../../../../migrations/1716000000068-EncryptSmsSender';
import { SmsCredentialCipher } from './sms-credential.cipher';

describe('EncryptSmsSender migration', () => {
  const originalSecret = process.env.SMS_CREDENTIAL_SECRET;
  const secret = 'a-long-secret-for-sms-sender-migration-tests';

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.SMS_CREDENTIAL_SECRET;
    else process.env.SMS_CREDENTIAL_SECRET = originalSecret;
  });

  it('rewrites existing plaintext sender values before dropping the old column', async () => {
    process.env.SMS_CREDENTIAL_SECRET = secret;
    const queries: { sql: string; params?: unknown[] }[] = [];
    const queryRunner = {
      query: jest.fn((sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return Promise.resolve(
          sql.startsWith('SELECT')
            ? [{ id: '7', sender: 'TEST_SENDER' }]
            : undefined,
        );
      }),
    } as unknown as QueryRunner;

    await new EncryptSmsSender1716000000068().up(queryRunner);

    const update = queries.find(({ sql }) => sql.startsWith('UPDATE'));
    expect(update?.params?.[0]).toMatch(/^enc:gcm:/);
    expect(
      new SmsCredentialCipher(secret).decrypt(update?.params?.[0] as string),
    ).toBe('TEST_SENDER');
    expect(update?.params?.[1]).toBe('7');
    expect(queries.findIndex(({ sql }) => sql.includes('DROP COLUMN'))).toBe(
      queries.length - 1,
    );
  });
});
