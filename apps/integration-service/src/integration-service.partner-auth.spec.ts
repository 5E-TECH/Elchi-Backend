import { createHash } from 'crypto';
import { IntegrationServiceService } from './integration-service.service';

/**
 * validatePartnerKey — faqat `this.partnerRepo`ga tayanadi, shu bois og‘ir
 * konstruktorni ishga tushirmasdan prototip orqali sinaymiz.
 */
function makeService(findOne: jest.Mock): IntegrationServiceService {
  const svc = Object.create(
    IntegrationServiceService.prototype,
  ) as IntegrationServiceService & { partnerRepo: { findOne: jest.Mock } };
  svc.partnerRepo = { findOne };
  return svc;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

describe('IntegrationServiceService.validatePartnerKey', () => {
  it('yaroqli kalit -> {id,name}, sha256 hash + faol filtri bilan qidiradi', async () => {
    const findOne = jest.fn(() =>
      Promise.resolve({ id: '7', name: 'Acme Market' }),
    );
    const svc = makeService(findOne);

    const result = await svc.validatePartnerKey('super-secret-key');

    expect(result).toEqual({ id: '7', name: 'Acme Market' });
    expect(findOne).toHaveBeenCalledWith({
      where: {
        api_key_hash: sha256('super-secret-key'),
        is_active: true,
        isDeleted: false,
      },
      select: { id: true, name: true },
    });
  });

  it('noma‘lum kalit -> null', async () => {
    const svc = makeService(jest.fn(() => Promise.resolve(null)));
    await expect(svc.validatePartnerKey('nope')).resolves.toBeNull();
  });

  it('bo‘sh kalit -> null (bazaga umuman bormaydi)', async () => {
    const findOne = jest.fn(() => Promise.resolve(null));
    const svc = makeService(findOne);

    await expect(svc.validatePartnerKey('')).resolves.toBeNull();
    await expect(svc.validatePartnerKey('   ')).resolves.toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });
});
