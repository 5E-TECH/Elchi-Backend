import { returnedRows } from './advisor-sql';

describe('returnedRows (BE-5)', () => {
  it('UPDATE natijasi [rows, count] → rows; SELECT/INSERT rows o‘zgarishsiz', () => {
    expect(returnedRows([[], 0])).toEqual([]);
    expect(returnedRows([[{ id: '1' }], 1])).toEqual([{ id: '1' }]);
    expect(returnedRows([{ id: '1' }, { id: '2' }])).toEqual([
      { id: '1' },
      { id: '2' },
    ]);
    expect(returnedRows(undefined)).toEqual([]);
  });
});
