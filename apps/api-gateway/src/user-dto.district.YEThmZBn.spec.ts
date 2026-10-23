/**
 * YEThmZBn TC3 — PATCH /users/:id `district_id` bilan: ilgari
 * UpdateAdminRequestDto'da maydon yo'q edi va global ValidationPipe
 * (whitelist + forbidNonWhitelisted) 400 qaytarardi. Mavjudlik va viloyatga
 * mosligini identity tekshiradi — bu yerda faqat shakl.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateAdminRequestDto } from './dto/identity.swagger.dto';

const errorsFor = async (body: Record<string, unknown>) =>
  validate(plainToInstance(UpdateAdminRequestDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

describe('UpdateAdminRequestDto — district_id (YEThmZBn)', () => {
  it.each([['41'], ['1'], [null]])(
    '⭐ district_id=%p — qabul qilinadi',
    async (district_id) => {
      expect(await errorsFor({ district_id })).toEqual([]);
    },
  );

  it('boshqa maydonlar bilan birga ham o`tadi', async () => {
    expect(await errorsFor({ name: 'Kuryer', district_id: '41' })).toEqual([]);
  });

  it.each([['abc'], ['-1'], ['4.1'], [''], [41]])(
    'district_id=%p — 400 (raqamli satr emas)',
    async (district_id) => {
      const errors = await errorsFor({ district_id });
      expect(errors.map((e) => e.property)).toEqual(['district_id']);
    },
  );
});
