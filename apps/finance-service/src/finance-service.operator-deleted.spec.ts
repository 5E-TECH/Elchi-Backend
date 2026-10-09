import { of } from 'rxjs';
import { FinanceServiceService } from './finance-service.service';

/**
 * (i76gGjyq) O'chirilgan market operatori: komissiya olish identity'dan
 * `include_deleted: true` bilan so'raladi — aks holda 404 va `finance.*`
 * outbox hodisasi cheksiz qayta urinardi.
 */
describe('fetchOperatorCommission — o`chirilgan operator (i76gGjyq)', () => {
  it('identity.user.find_by_id ga include_deleted: true yuboradi', async () => {
    const svc: any = Object.create(FinanceServiceService.prototype);
    const send = jest.fn(() =>
      of({ data: { commission_type: 'percent', commission_value: 5 } }),
    );
    svc.identityClient = { send };
    svc.logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };

    const res = await svc.fetchOperatorCommission('77');

    expect(send).toHaveBeenCalledWith(
      { cmd: 'identity.user.find_by_id' },
      expect.objectContaining({ id: '77', include_deleted: true }),
    );
    expect(res).toMatchObject({ commission_type: 'percent' });
  });
});
