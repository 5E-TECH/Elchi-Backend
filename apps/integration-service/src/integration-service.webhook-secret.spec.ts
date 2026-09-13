import { IntegrationServiceService } from './integration-service.service';

/**
 * WEBHOOK SEKRETI — shifrlash va ROTATSIYA OYNASI.
 *
 * IKKI XATO SHU TESTLAR BILAN QULFLANADI:
 *
 * 1) `updateIntegration` ichida `Object.assign(row, dto)` XOM qiymatni
 *    yozadi. Sekret shu holda qolsa bazada OCHIQ saqlanardi va
 *    `receiveWebhook` dagi `decryptCredential` uni o'qiy olmay har kiruvchi
 *    webhookni 401 qilardi — sababi esa hech qayerda ko'rinmasdi.
 *
 * 2) Rotatsiya oynasi: tashqi tizim sekretni bir zumda almashtira olmaydi.
 *    Oyna bo'lmasa almashtirish paytida kelgan har webhook yo'qolardi.
 *    ⚠️ Oynani surish qarori SHIFRMATNNI solishtirib qilinmaydi —
 *    `encryptCredential` tasodifiy IV ishlatadi, ya'ni ayni sekret har safar
 *    boshqa shifrmatn beradi. OCHIQ MATNLAR solishtiriladi.
 */

function makeService(row: Record<string, unknown>) {
  const saved: Record<string, unknown>[] = [];
  const repo = {
    findOne: jest.fn().mockResolvedValue(row),
    save: jest.fn((r: Record<string, unknown>) => {
      saved.push({ ...r });
      return Promise.resolve(r);
    }),
  };

  const svc = Object.create(
    IntegrationServiceService.prototype,
  ) as IntegrationServiceService & Record<string, unknown>;

  Object.assign(svc, {
    integrationRepo: repo,
    activityLog: {
      log: jest.fn().mockResolvedValue(undefined),
      logChange: jest.fn().mockResolvedValue(undefined),
    },
    // AES kalit — 32 bayt.
    primaryKey: Buffer.alloc(32, 7),
    allowPrivateHosts: true,
    attachMarkets: jest.fn((rows: unknown[]) => Promise.resolve(rows)),
    sanitizeIntegrationRow: (r: unknown) => r,
    tokenCache: new Map(),
    clearTokenCache: jest.fn(),
  });

  return { svc, repo, saved };
}

/** Haqiqiy shifrlash/deshifrlash ishlatiladi — mock emas. */
const enc = (svc: any, v: string) => svc.encryptCredential(v) as string;
const dec = (svc: any, v: string | null) =>
  svc.decryptCredential(v) as string | null;

describe('webhook_secret — shifrlash', () => {
  it('⭐ yangi sekret SHIFRLANGAN holda saqlanadi (xom emas)', async () => {
    const row: Record<string, unknown> = {
      id: '1',
      slug: 'donoxon',
      webhook_secret: null,
      webhook_secret_previous: null,
      isDeleted: false,
    };
    const { svc, saved } = makeService(row);

    await (svc as any).updateIntegration('1', {
      webhook_secret: 'yangi-sirim',
    });

    const out = saved[0];
    expect(out.webhook_secret).not.toBe('yangi-sirim');
    expect(dec(svc, out.webhook_secret as string)).toBe('yangi-sirim');
  });

  it("⭐ bo'sh satr — sekret VA oyna tozalanadi", async () => {
    /**
     * Oynani ham yopish shart: aks holda o'chirilgan sekret
     * `webhook_secret_previous` orqali ishlashda davom etardi va
     * "o'chirdim" degan amal yolg'on bo'lardi.
     */
    const { svc, saved } = makeService({
      id: '1',
      slug: 'd',
      webhook_secret: 'enc:eski',
      webhook_secret_previous: 'enc:juda-eski',
      isDeleted: false,
    });

    await (svc as any).updateIntegration('1', { webhook_secret: '' });

    expect(saved[0].webhook_secret).toBeNull();
    expect(saved[0].webhook_secret_previous).toBeNull();
  });

  it('sekret berilmasa tegilmaydi', async () => {
    const { svc, saved } = makeService({
      id: '1',
      slug: 'd',
      webhook_secret: 'enc:eski',
      webhook_secret_previous: null,
      isDeleted: false,
    });

    await (svc as any).updateIntegration('1', { name: 'Boshqa nom' });

    expect(saved[0].webhook_secret).toBe('enc:eski');
    expect(saved[0].webhook_secret_previous).toBeNull();
  });
});

describe('webhook_secret — rotatsiya oynasi', () => {
  it("⭐ sekret O'ZGARSA eskisi oynaga ko'chadi", async () => {
    const tmp = makeService({});
    const oldEnc = enc(tmp.svc, 'eski-sir');

    const { svc, saved } = makeService({
      id: '1',
      slug: 'd',
      webhook_secret: oldEnc,
      webhook_secret_previous: null,
      isDeleted: false,
    });

    await (svc as any).updateIntegration('1', { webhook_secret: 'yangi-sir' });

    expect(dec(svc, saved[0].webhook_secret as string)).toBe('yangi-sir');
    expect(dec(svc, saved[0].webhook_secret_previous as string)).toBe(
      'eski-sir',
    );
  });

  it('⭐ AYNI sekret qayta saqlansa oyna SURILMAYDI', async () => {
    /**
     * Eng nozik joy. `encryptCredential` tasodifiy IV ishlatadi, ya'ni ayni
     * sekret har safar BOSHQA shifrmatn beradi. Shifrmatnlarni solishtirsak
     * "o'zgardi" har doim rost bo'lib, oyna bekorga surilardi.
     */
    const tmp = makeService({});
    const sameEnc = enc(tmp.svc, 'bir-xil-sir');

    const { svc, saved } = makeService({
      id: '1',
      slug: 'd',
      webhook_secret: sameEnc,
      webhook_secret_previous: null,
      isDeleted: false,
    });

    await (svc as any).updateIntegration('1', {
      webhook_secret: 'bir-xil-sir',
    });

    expect(dec(svc, saved[0].webhook_secret as string)).toBe('bir-xil-sir');
    expect(saved[0].webhook_secret_previous).toBeNull();
  });

  it('shifrlash TASODIFIY — ayni matn har safar boshqa natija beradi', async () => {
    // Bu testning maqsadi — yuqoridagi qaror nima uchun kerakligini qulflash.
    const { svc } = makeService({});
    expect(enc(svc, 'a')).not.toBe(enc(svc, 'a'));
    expect(dec(svc, enc(svc, 'a'))).toBe('a');
  });
});
