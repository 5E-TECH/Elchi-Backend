import { createHash } from 'crypto';
import { IntegrationServiceService } from './integration-service.service';

/**
 * Partner CRUD (C1.3) — prototip orqali sinaladi (og'ir konstruktorsiz).
 * primaryKey (AES) qo'lda beriladi, chunki Object.create maydon
 * initsializatorlarini ishga tushirmaydi.
 */
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function makeService(repo: Record<string, jest.Mock>, log: jest.Mock) {
  const svc = Object.create(IntegrationServiceService.prototype);
  svc.partnerRepo = repo;
  svc.activityLog = { log };
  svc.primaryKey = createHash('sha256').update('x'.repeat(40)).digest();
  svc.previousKey = null;
  svc.logger = { warn: jest.fn(), error: jest.fn() };
  return svc as IntegrationServiceService;
}

describe('IntegrationServiceService — Partner CRUD (C1.3)', () => {
  it('TC1: create -> kalit BIR MARTA qaytadi; bazada faqat hash + AES secret', async () => {
    const created: any[] = [];
    const repo = {
      create: jest.fn((x: unknown) => {
        created.push(x);
        return x;
      }),
      save: jest.fn((x: any) => Promise.resolve({ id: '1', ...x })),
    };
    const log = jest.fn(() => Promise.resolve(undefined));
    const svc = makeService(repo, log);

    const res: any = await svc.createPartner({
      name: 'Acme Market',
      webhook_secret: 'top-secret',
      requester: { id: 'admin1', roles: ['superadmin'] },
    });

    // Kalit javobda bir marta, elp_ + 64 hex
    expect(res.statusCode).toBe(201);
    expect(res.data.api_key).toMatch(/^elp_[0-9a-f]{64}$/);

    // Bazaga ochiq kalit EMAS — sha256 hash saqlanadi
    const row = created[0];
    expect(row.api_key_hash).toBe(sha256(res.data.api_key));
    expect(row.api_key_hash).not.toContain(res.data.api_key);

    // webhook_secret AES bilan shifrlangan (ochiq emas)
    expect(row.webhook_secret).toMatch(/^enc:/);
    expect(row.webhook_secret).not.toContain('top-secret');
    expect(row.is_active).toBe(true);

    // TC4: activity-log yozildi va sir(kalit/secret) SIZMAYDI
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ entity_type: 'Partner' }),
    );
    const logged = JSON.stringify(log.mock.calls[0][0]);
    expect(logged).not.toContain(res.data.api_key);
    expect(logged).not.toContain('top-secret');
  });

  it('TC2: rotate -> saqlangan hash yangilanadi (eski kalit endi mos kelmaydi)', async () => {
    const partner: any = {
      id: '1',
      api_key_hash: sha256('elp_OLD'),
      is_active: true,
    };
    const repo = {
      findOne: jest.fn(() => Promise.resolve(partner)),
      save: jest.fn((x: any) => Promise.resolve(x)),
    };
    const log = jest.fn(() => Promise.resolve(undefined));
    const svc = makeService(repo, log);

    const res: any = await svc.rotatePartnerKey('1', { id: 'admin1' });

    const newKey = res.data.api_key;
    expect(newKey).toMatch(/^elp_/);
    // Yangi hash = sha256(yangi kalit); eski hash bilan mos emas -> eski kalit 401
    expect(partner.api_key_hash).toBe(sha256(newKey));
    expect(partner.api_key_hash).not.toBe(sha256('elp_OLD'));
    expect(log).toHaveBeenCalled(); // TC4
  });

  it('activate/deactivate -> is_active yangilanadi + activity-log', async () => {
    const partner: any = { id: '1', is_active: true };
    const repo = {
      findOne: jest.fn(() => Promise.resolve(partner)),
      save: jest.fn((x: any) => Promise.resolve(x)),
    };
    const log = jest.fn(() => Promise.resolve(undefined));
    const svc = makeService(repo, log);

    const res: any = await svc.setPartnerActive('1', false, { id: 'admin1' });

    expect(partner.is_active).toBe(false);
    expect(res.data.is_active).toBe(false);
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'Partner',
        new_value: { is_active: false },
      }),
    );
  });
});
