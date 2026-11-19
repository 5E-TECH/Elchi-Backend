import { projectReceiptsForViewer } from './finance-receipt-projection';

/**
 * 63HO6cBU (P0) — filial kassasi naqd/kartaga ajralmaydi: KURYER
 * ko'rinishida FILIAL oyog'i qatorlarida (`branch_leg: true`, finance
 * belgilaydi) `payment_method` va `card_id` qaytmaydi (eski qatorlarda ham);
 * SA/admin va — ega qarori (Q2) — menejer / registrator usulni ko'radi.
 */
describe('63HO6cBU — filial qatorlarida to`lov usuli rol bo`yicha', () => {
  const payload = () => ({
    statusCode: 200,
    data: {
      items: [
        {
          id: '1',
          branch_leg: true,
          payment_method: 'click',
          card_id: '7',
          amount: 100,
          cashbox: { cashbox_type: 'branch' },
        },
        {
          id: '2',
          payment_method: 'click',
          card_id: '3',
          amount: 50,
          cashbox: { cashbox_type: 'main' },
        },
      ],
      // Tafsilot (history/:id) shakli ham.
      detail: {
        id: '9',
        branch_leg: true,
        payment_method: 'click',
        card_id: null,
        card: { id: null, name: 'Asosiy karta', is_default: true },
        transfer_source_user_id: '7',
        transfer_source_user: { id: '7', name: 'Ali' },
      },
    },
  });
  const view = (roles: string[]) =>
    projectReceiptsForViewer(payload(), {
      roles,
      branchId: '15',
      req: {},
    });

  it.each([['courier']])(
    '%s — filial qatorida usul va karta null; boshqa qator tegilmaydi',
    (role) => {
      const out = view([role]);
      expect(out.data.items[0]).toMatchObject({
        id: '1',
        payment_method: null,
        card_id: null,
        amount: 100,
      });
      expect(out.data.items[1]).toMatchObject({
        payment_method: 'click',
        card_id: '3',
      });
      expect(out.data.detail).toMatchObject({
        payment_method: null,
        card_id: null,
        card: null,
        transfer_source_user_id: null,
        transfer_source_user: null,
      });
    },
  );

  it.each([['superadmin'], ['admin'], ['manager'], ['registrator']])(
    '%s — usul saqlanadi (menejer / registrator — ega qarori Q2)',
    (role) => {
      const out = view([role]);
      expect(out.data.items[0]).toMatchObject({
        payment_method: 'click',
        card_id: '7',
      });
      expect(out.data.detail).toMatchObject({
        payment_method: 'click',
        transfer_source_user_id: '7',
      });
      expect(out.data.items[0].branch_leg).toBe(true);
    },
  );

  it('kuryer + menejer roli birga — menejer sifatida ko`radi', () => {
    expect(view(['courier', 'manager']).data.items[0]).toMatchObject({
      payment_method: 'click',
    });
  });
});
