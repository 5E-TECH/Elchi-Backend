import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsDateString,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsNumberString,
  IsObject,
  IsPhoneNumber,
  IsPositive,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { translateValidationMessage } from '@app/common';
import {
  CreateAdminRequestDto,
  CreateCourierRequestDto,
} from '../dto/identity.swagger.dto';
import { CreatePartnerMarketRequestDto } from '../dto/partner-market.swagger.dto';
import { CreatePartnerShipmentRequestDto } from '../dto/partner-shipment.swagger.dto';
import { CreatePartnerRequestDto } from '../dto/partner.swagger.dto';
import { CreateWarehouseRequestDto } from '../dto/warehouse.swagger.dto';
import { PartnerGatewayController } from '../partner-gateway.controller';
import {
  UzValidationPipe,
  shouldTranslateValidation,
} from './uz-validation.pipe';

/**
 * (ZDweRm02) class-validator inglizcha xabarlari → o'zbekcha; maxsus (DTO'dagi)
 * xabarlar va konvert o'zgarmaydi; hamkor API (`/partner/*`) DTO'lari tarjima
 * qilinmaydi — tashqi shartnoma.
 */
const ENGLISH_LEFT = /\b(must|should|each value|property|shorter|longer)\b/;

enum SampleStatus {
  ACTIVE = 'active',
}

/** Loyiha DTO'larida ishlatiladigan har dekorator — haqiqiy class-validator matni bilan. */
class EveryDecoratorDto {
  @IsString() a!: string;
  @Matches(/^x$/) b!: string;
  @Min(5) c!: number;
  @Max(5) d!: number;
  @IsNumber() e!: number;
  @IsBoolean() f!: boolean;
  @IsEnum(SampleStatus) g!: string;
  @IsNotEmpty() h!: string;
  @MaxLength(1) i!: string;
  @MinLength(5) j!: string;
  @IsIn(['x']) k!: string;
  @IsArray() l!: string[];
  @IsInt() m!: number;
  @IsObject() n!: object;
  @IsNumberString() o!: string;
  @ArrayMaxSize(1) p!: string[];
  @ArrayMinSize(2) q!: string[];
  @ArrayNotEmpty() r!: string[];
  @IsPhoneNumber() s!: string;
  @IsDateString() t!: string;
  @Length(2, 3) u!: string;
  @IsUrl() v!: string;
  @IsDefined() w!: string;
  @IsUUID() x!: string;
  @Equals('x') y!: string;
  @ArrayUnique() z!: string[];
  @IsPositive() aa!: number;
}

class NestedChildDto {
  @IsString() name!: string;
  @IsString({ each: true }) labels!: string[];
  @ArrayUnique() codes!: string[];
}

class NestedParentDto {
  @ValidateNested({ each: true })
  @Type(() => NestedChildDto)
  items!: NestedChildDto[];

  @ValidateNested()
  @Type(() => NestedChildDto)
  child!: NestedChildDto;
}

describe('ZDweRm02 — translateValidationMessage', () => {
  it.each([
    [
      'name must be longer than or equal to 2 characters',
      "name: kamida 2 belgi bo'lishi kerak",
    ],
    [
      'note must be shorter than or equal to 500 characters',
      "note: ko'pi bilan 500 belgi bo'lishi kerak",
    ],
    ['name must be a string', "name: matn bo'lishi kerak"],
    [
      'phone_number must be a valid phone number',
      "phone_number: telefon raqami noto'g'ri",
    ],
    [
      'salary must be a number conforming to the specified constraints',
      "salary: son bo'lishi kerak",
    ],
    ['salary must not be less than 0', "salary: kamida 0 bo'lishi kerak"],
    [
      'payment_day must not be greater than 30',
      "payment_day: ko'pi bilan 30 bo'lishi kerak",
    ],
    [
      'status must be one of the following values: active, inactive',
      "status: quyidagilardan biri bo'lishi kerak: active, inactive",
    ],
    [
      'add_order must be a boolean value',
      "add_order: true yoki false bo'lishi kerak",
    ],
    ['property foo should not exist', 'foo: bunday maydon qabul qilinmaydi'],
    [
      'customer.property foo should not exist',
      'customer.foo: bunday maydon qabul qilinmaydi',
    ],
    [
      'customer.district_id should not be empty',
      "customer.district_id: bo'sh bo'lmasligi kerak",
    ],
    [
      'items must contain at least 1 elements',
      "items: kamida 1 ta element bo'lishi kerak",
    ],
    [
      'each value in tags must be a string',
      "tags (har bir qiymat): matn bo'lishi kerak",
    ],
    ['code must match /^\\d+$/ regular expression', "code: formati noto'g'ri"],
    [
      'items.0.each value in tags must be a string',
      "items.0.tags (har bir qiymat): matn bo'lishi kerak",
    ],
    [
      "items.0.All codes's elements must be unique",
      'items.0.codes: elementlar takrorlanmasligi kerak',
    ],
    [
      'customer.nested property address must be either object or array',
      "customer.address: obyekt yoki ro'yxat bo'lishi kerak",
    ],
    // DTO'lardagi inglizcha `{ message }`.
    ['endpoint must be an https URL', "endpoint: https manzil bo'lishi kerak"],
    [
      'operator_id must be a bigint-like numeric string',
      "operator_id: raqamli bo'lishi kerak",
    ],
    [
      'user_id must be a positive integer',
      "user_id: musbat butun son bo'lishi kerak",
    ],
    [
      'default_tariff must be either center or address',
      "default_tariff: center yoki address bo'lishi kerak",
    ],
  ])('%s', (english, uzbek) => {
    expect(translateValidationMessage(english)).toBe(uzbek);
  });

  it('maxsus / o‘zbekcha xabar — o‘zgarishsiz', () => {
    for (const custom of [
      "district_id raqamli ID bo'lishi kerak",
      'Parol kamida 10 belgidan iborat bo‘lishi kerak',
      'Buyurtma uchun tuman tanlanmagan',
    ]) {
      expect(translateValidationMessage(custom)).toBe(custom);
    }
  });
});

describe('ZDweRm02 — UzValidationPipe', () => {
  const pipe = new UzValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });
  const errorOf = async (metatype: new () => object, value: object) => {
    const error: unknown = await pipe
      .transform(value, { type: 'body', metatype })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as {
      statusCode: number;
      message: string[];
      error: string;
    };
  };

  it('identity.swagger.dto `@MinLength(2)` — o‘zbekcha, konvert avvalgidek (400, message[], error)', async () => {
    const response = await errorOf(CreateAdminRequestDto, {
      name: 'A',
      phone_number: '+998935557711',
      salary: 0,
      extra: 1,
    });
    expect(response.statusCode).toBe(400);
    expect(response.error).toBe('Bad Request');
    expect(response.message).toEqual(
      expect.arrayContaining([
        'extra: bunday maydon qabul qilinmaydi',
        "name: kamida 2 belgi bo'lishi kerak",
      ]),
    );
    expect(response.message.join(' ')).not.toMatch(/must be|should not/);
  });

  it('DTO’dagi maxsus xabar saqlanadi', async () => {
    const response = await errorOf(CreateCourierRequestDto, {
      name: 'TEST Kuryer',
      phone_number: '+998935557711',
      tariff_home: 1,
      tariff_center: 1,
      district_id: 'abc',
    });
    expect(response.message).toEqual(["district_id raqamli ID bo'lishi kerak"]);
  });

  it('loyihada ishlatiladigan har dekoratorning standart matni o‘zbekcha', async () => {
    const response = await errorOf(EveryDecoratorDto, {
      b: 'y',
      c: 1,
      d: 9,
      e: 'x',
      f: 'x',
      g: 'x',
      h: '',
      i: 'xx',
      j: 'x',
      k: 'y',
      l: 'x',
      m: 1.5,
      n: 'x',
      o: 'x',
      p: ['1', '2'],
      q: ['1'],
      r: [],
      s: 'x',
      t: 'x',
      u: 'x',
      v: 'x',
      x: 'x',
      y: 'y',
      z: ['1', '1'],
      aa: -1,
    });
    // Har maydon (27 ta) xato berdi — hech biri jimgina tushib qolmagan.
    expect(new Set(response.message.map((m) => m.split(':')[0])).size).toBe(27);
    expect(response.message.join(' | ')).not.toMatch(ENGLISH_LEFT);
  });

  it('ichma-ich DTO: yo‘l saqlanadi, inglizcha qolmaydi', async () => {
    const response = await errorOf(NestedParentDto, {
      items: [{ name: 1, labels: [1], codes: ['1', '1'], extra: 1 }],
      child: 'x',
    });
    expect(response.message).toEqual(
      expect.arrayContaining([
        "items.0.name: matn bo'lishi kerak",
        "items.0.labels (har bir qiymat): matn bo'lishi kerak",
        'items.0.codes: elementlar takrorlanmasligi kerak',
        'items.0.extra: bunday maydon qabul qilinmaydi',
      ]),
    );
    expect(response.message.join(' | ')).not.toMatch(ENGLISH_LEFT);
  });

  it('`scheduled_at` kabi maydon nomi matnda qoladi (FE shu bo‘yicha taniydi)', () => {
    expect(
      translateValidationMessage('scheduled_at must be a string'),
    ).toContain('scheduled_at');
  });

  it('hamkor API: `/partner/*` har DTO’si inglizcha qoladi (MARKETPLACE_API.md)', async () => {
    const proto = PartnerGatewayController.prototype as unknown as object;
    const routeDtos = Object.getOwnPropertyNames(proto).flatMap((key) =>
      (
        (Reflect.getMetadata('design:paramtypes', proto, key) ??
          []) as unknown[]
      ).filter(
        (type) =>
          typeof type === 'function' &&
          ![Object, String, Number, Boolean, Array].includes(
            type as ObjectConstructor,
          ),
      ),
    ) as (new () => object)[];

    expect(routeDtos.length).toBeGreaterThanOrEqual(4);
    for (const dto of routeDtos) {
      expect(shouldTranslateValidation(dto)).toBe(false);
    }

    const market = await errorOf(CreatePartnerMarketRequestDto, { foo: 1 });
    expect(market.message.join(' ')).toMatch(/property foo should not exist/);
    const shipment = await errorOf(CreatePartnerShipmentRequestDto, {
      foo: 1,
    });
    expect(shipment.message.join(' ')).toMatch(ENGLISH_LEFT);
  });

  it('ichki DTO’lar tarjima qilinadi: `/admin/partners`, ombor', async () => {
    expect(shouldTranslateValidation(CreateAdminRequestDto)).toBe(true);
    for (const dto of [CreatePartnerRequestDto, CreateWarehouseRequestDto]) {
      const response = await errorOf(dto, { foo: 1 });
      expect(response.message).toContain('foo: bunday maydon qabul qilinmaydi');
      expect(response.message.join(' | ')).not.toMatch(ENGLISH_LEFT);
    }
  });

  it('to‘g‘ri qiymat — o‘zgarishsiz o‘tadi', async () => {
    await expect(
      pipe.transform(
        { name: 'TEST Admin', phone_number: '+998935557711', salary: 0 },
        { type: 'body', metatype: CreateAdminRequestDto },
      ),
    ).resolves.toBeInstanceOf(CreateAdminRequestDto);
  });
});
