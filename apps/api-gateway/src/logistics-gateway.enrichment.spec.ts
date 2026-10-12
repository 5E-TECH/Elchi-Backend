import 'reflect-metadata';
import { of } from 'rxjs';
import { ROLES_KEY } from './auth/roles.decorator';
import { LogisticsGatewayController } from './logistics-gateway.controller';

describe('VfgcnxDa - pochta buyurtmalarining xavfsiz boyitilishi', () => {
  const row = { id: '10', market_id: '2', customer_id: '3', district_id: '4' };
  const market = {
    id: '2',
    name: 'Market',
    phone_number: '+998901112233',
    market_tg_token: 'secret',
    salary: 100,
    username: 'private',
    settings: { private: true },
    commission_value: 20,
  };
  const customer = {
    id: '3',
    name: 'Customer',
    phone_number: '+998907778899',
    address: 'Toshkent',
    district_id: '4',
    salary: 100,
    username: 'private',
    settings: { private: true },
  };
  const district = {
    id: '4',
    name: 'District',
    region: { id: '5', name: 'Region', settings: { private: true } },
    settings: { private: true },
  };

  const build = () => {
    const logistics = {
      send: jest.fn((pattern: { cmd: string }) => {
        if (pattern.cmd === 'logistics.post.orders_by_post') {
          return of({ data: { allOrdersByPostId: [row] } });
        }
        if (pattern.cmd === 'logistics.post.rejected_orders_by_post') {
          return of({ data: [row] });
        }
        return of({ data: district });
      }),
    };
    const identity = {
      send: jest.fn((pattern: { cmd: string }) =>
        of({
          data:
            pattern.cmd === 'identity.market.find_by_id' ? market : customer,
        }),
      ),
    };
    return new LogisticsGatewayController(logistics as any, identity as any);
  };

  it.each(['superadmin', 'courier'])(
    'GET /post/orders/:id (%s) maxfiy maydonlarni chiqarmaydi',
    async (role) => {
      const controller = build();
      const result = await controller.getOrdersByPost('1', {
        user: { sub: '9', roles: [role] },
      });
      const enriched = result.data.allOrdersByPostId[0];

      expect(JSON.stringify(result)).not.toMatch(
        /market_tg_token|salary|username|settings|commission_/,
      );
      expect(enriched).toEqual({
        ...row,
        market: {
          id: '2',
          name: 'Market',
          phone_number: '+998901112233',
        },
        customer: {
          id: '3',
          name: 'Customer',
          phone_number: '+998907778899',
          address: 'Toshkent',
          district_id: '4',
        },
        district: {
          id: '4',
          name: 'District',
          region: { id: '5', name: 'Region' },
        },
      });
    },
  );

  it('courier roli pochta detali marshrutida ruxsat etilgan', () => {
    const route = Object.getOwnPropertyDescriptor(
      LogisticsGatewayController.prototype,
      'getOrdersByPost',
    );
    expect(Reflect.getMetadata(ROLES_KEY, route?.value)).toContain('courier');
  });

  it('rad etilgan buyurtmalarda ham bir xil oq royxat ishlaydi', async () => {
    const result = await build().getRejectedOrdersByPost('1', {
      user: { sub: '9', roles: ['superadmin'] },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /market_tg_token|salary|username|settings|commission_/,
    );
    expect(result.data[0].market).toEqual({
      id: '2',
      name: 'Market',
      phone_number: '+998901112233',
    });
  });
});
