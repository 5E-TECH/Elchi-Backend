import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateBranchRequestDto } from './branch.swagger.dto';

// EiZj47Gc: forma PICKUP uchun `parent_id: ''` yuborardi va gateway uni
// "parent_id must be a number string" bilan rad etardi. Endi '' / null →
// undefined; so'rov branch-service'ga yetib, u yerda aniq qoida qo'llanadi.
describe('EiZj47Gc — CreateBranchRequestDto.parent_id', () => {
  const base = { name: 'ZZ Audit Pickup', type: 'PICKUP', code: 'ZZPK1' };
  const parentErrors = async (body: object) => {
    const dto = plainToInstance(CreateBranchRequestDto, body);
    return {
      dto,
      errors: (await validate(dto)).filter((e) => e.property === 'parent_id'),
    };
  };

  it.each([[''], [null]])(
    "parent_id %p — gateway 400 bermaydi, undefined bo'ladi",
    async (value) => {
      const { dto, errors } = await parentErrors({ ...base, parent_id: value });
      expect(errors).toHaveLength(0);
      expect(dto.parent_id).toBeUndefined();
    },
  );

  it("raqamli satr parent_id o'zgarmaydi", async () => {
    const { dto, errors } = await parentErrors({ ...base, parent_id: '1' });
    expect(errors).toHaveLength(0);
    expect(dto.parent_id).toBe('1');
  });

  it("raqam bo'lmagan parent_id hali ham rad etiladi", async () => {
    const { errors } = await parentErrors({ ...base, parent_id: 'abc' });
    expect(errors).not.toHaveLength(0);
  });
});
