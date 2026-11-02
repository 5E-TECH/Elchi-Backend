import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  CreateDistrictRequestDto,
  UpdateDistrictSatoCodeRequestDto,
} from './logistics.swagger.dto';

/**
 * Mahsulot egasi: yangi tuman SOATO kodisiz qo'shilmaydi. Gateway darajasida:
 * `sato_code` majburiy, kesiladi (trim), aniq 7 raqam (viloyat kodi 4 raqam).
 * Takrorlanmaslik va viloyat prefiksi — logistics-service'da.
 */
describe('CreateDistrictRequestDto / UpdateDistrictSatoCodeRequestDto — sato_code', () => {
  const satoErrors = async (
    cls:
      typeof CreateDistrictRequestDto | typeof UpdateDistrictSatoCodeRequestDto,
    body: object,
  ) => {
    const dto = plainToInstance(cls, body);
    const errors = (await validate(dto)).filter(
      (e) => e.property === 'sato_code',
    );
    return {
      dto,
      errors,
      messages: errors.flatMap((e) => Object.values(e.constraints ?? {})),
    };
  };
  const base = { name: 'Yangi tuman', region_id: '1' };

  it("POST: sato_code yo'q — 400 «Tuman SOATO kodi majburiy»", async () => {
    const { messages } = await satoErrors(CreateDistrictRequestDto, base);
    expect(messages).toContain('Tuman SOATO kodi majburiy');
  });

  it.each([[''], ['   ']])(
    'POST: bo‘sh sato_code (%p) — majburiy xatosi',
    async (sato_code) => {
      const { messages } = await satoErrors(CreateDistrictRequestDto, {
        ...base,
        sato_code,
      });
      expect(messages).toContain('Tuman SOATO kodi majburiy');
    },
  );

  it.each([
    [CreateDistrictRequestDto, base],
    [UpdateDistrictSatoCodeRequestDto, {}],
  ] as const)('%p: kod kesiladi, 7 raqam o‘tadi', async (cls, extra) => {
    const { dto, errors } = await satoErrors(cls, {
      ...extra,
      sato_code: ' 1703206 ',
    });
    expect(errors).toHaveLength(0);
    expect(dto.sato_code).toBe('1703206');
  });

  it.each([['170320'], ['17032060'], ['1703'], ['17O3206'], ['1703 206']])(
    'POST va PATCH: 7 raqam emas (%p) — rad etiladi',
    async (sato_code) => {
      for (const [cls, extra] of [
        [CreateDistrictRequestDto, base],
        [UpdateDistrictSatoCodeRequestDto, {}],
      ] as const) {
        const { messages } = await satoErrors(cls, { ...extra, sato_code });
        expect(messages).toContain(
          "Tuman SOATO kodi aniq 7 ta raqamdan iborat bo'lishi kerak",
        );
      }
    },
  );

  it('POST va PATCH: raqam (string emas) rad etiladi', async () => {
    for (const [cls, extra] of [
      [CreateDistrictRequestDto, base],
      [UpdateDistrictSatoCodeRequestDto, {}],
    ] as const) {
      const { errors } = await satoErrors(cls, {
        ...extra,
        sato_code: 1703206,
      });
      expect(errors).not.toHaveLength(0);
    }
  });

  it("PATCH: sato_code yo'q — majburiy xatosi", async () => {
    const { messages } = await satoErrors(UpdateDistrictSatoCodeRequestDto, {});
    expect(messages).toContain('Tuman SOATO kodi majburiy');
  });
});
