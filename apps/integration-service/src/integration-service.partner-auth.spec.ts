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
  it('yaroqli kalit -> {id,name,is_active}, sha256 hash bo‘yicha qidiradi', async () => {
    const findOne = jest.fn(() =>
      Promise.resolve({ id: '7', name: 'Acme Market', is_active: true }),
    );
    const svc = makeService(findOne);

    const result = await svc.validatePartnerKey('super-secret-key');

    expect(result).toEqual({ id: '7', name: 'Acme Market', is_active: true });
    // is_active FILTRLANMAYDI — guard 401(topilmadi) va 403(faol emas)ni ajratsin.
    expect(findOne).toHaveBeenCalledWith({
      where: {
        api_key_hash: sha256('super-secret-key'),
        isDeleted: false,
      },
      select: { id: true, name: true, is_active: true },
    });
  });

  it('faol emas hamkor ham qaytadi (is_active:false) — 403ni guard hal qiladi', async () => {
    const svc = makeService(
      jest.fn(() =>
        Promise.resolve({ id: '9', name: 'Off', is_active: false }),
      ),
    );
    await expect(svc.validatePartnerKey('k')).resolves.toEqual({
      id: '9',
      name: 'Off',
      is_active: false,
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
