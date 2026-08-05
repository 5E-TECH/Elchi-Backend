import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { of } from 'rxjs';
import { PartnerGatewayController } from './partner-gateway.controller';

function makeController(logisticsSend: jest.Mock, identitySend: jest.Mock) {
  return new PartnerGatewayController(
    { send: logisticsSend } as unknown as ClientProxy,
    { send: identitySend } as unknown as ClientProxy,
  );
}

describe('PartnerGatewayController — geo passthrough (C1.4)', () => {
  it('TC1: regions -> bo‘sh emas, [{id,name}] shaklida (logistics passthrough)', async () => {
    const logistics = jest.fn(() =>
      of({
        data: [
          { id: 1, name: 'Toshkent', sato_code: '17' },
          { id: 2, name: 'Andijon', sato_code: '03' },
        ],
      }),
    );
    const ctrl = makeController(logistics, jest.fn());

    const regions = await ctrl.getRegions();

    expect(logistics).toHaveBeenCalledWith(
      { cmd: 'logistics.region.find_all' },
      {},
    );
    expect(regions.length).toBeGreaterThan(0);
    expect(regions[0]).toEqual({ id: '1', name: 'Toshkent' });
    // sato_code kabi ortiqcha maydonlar sizmaydi
    expect(Object.keys(regions[0])).toEqual(['id', 'name']);
  });

  it('TC2: districts?region_id -> region_id filtri bilan uzatiladi', async () => {
    const logistics = jest.fn(() =>
      of({ data: [{ id: 10, name: 'Chilonzor', region_id: 5 }] }),
    );
    const ctrl = makeController(logistics, jest.fn());

    const districts = await ctrl.getDistricts('5');

    expect(logistics).toHaveBeenCalledWith(
      { cmd: 'logistics.district.find_all' },
      { region_id: '5' },
    );
    expect(districts[0]).toEqual({
      id: '10',
      name: 'Chilonzor',
      region_id: '5',
    });
  });

  it('TC3: tariff -> where_deliver bo‘yicha market summasi qaytadi', async () => {
    const identity = jest.fn(() =>
      of({ data: [{ id: 77, tariff_home: 15000, tariff_center: 10000 }] }),
    );
    const ctrl = makeController(jest.fn(), identity);

    const center = await ctrl.getTariff('77', 'center');
    expect(identity).toHaveBeenCalledWith(
      { cmd: 'identity.market.find_by_ids' },
      { ids: ['77'] },
    );
    expect(center).toEqual({
      elchi_market_id: '77',
      where_deliver: 'center',
      market_tariff: 10000,
    });

    const address = await makeController(jest.fn(), identity).getTariff(
      '77',
      'address',
    );
    expect(address.market_tariff).toBe(15000);
  });

  it('tariff: elchi_market_id yo‘q -> 400', async () => {
    const ctrl = makeController(jest.fn(), jest.fn());
    await expect(ctrl.getTariff(undefined, 'center')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('tariff: market topilmadi -> 404', async () => {
    const identity = jest.fn(() => of({ data: [] }));
    const ctrl = makeController(jest.fn(), identity);
    await expect(ctrl.getTariff('999', 'center')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
