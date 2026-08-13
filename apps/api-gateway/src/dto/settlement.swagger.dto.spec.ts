import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  SettlementBranchToHqDto,
  SettlementCourierToBranchDto,
  SettlementHqToMarketDto,
} from './order.swagger.dto';

// Audit money/API-design P1: the settlement routes accepted an inline-typed
// { *_id, amount } body, so a negative or NaN amount reached order.settlement.*
// unvalidated. These DTOs (validated by the global ValidationPipe) close that.
describe('Settlement amount DTOs', () => {
  const amountErrors = async (dto: object) =>
    (await validate(dto)).filter((e) => e.property === 'amount');

  it('rejects a negative amount', async () => {
    const dto = plainToInstance(SettlementCourierToBranchDto, {
      courier_id: '5',
      amount: -100,
    });
    expect(await amountErrors(dto)).not.toHaveLength(0);
  });

  it('rejects a non-numeric / NaN amount', async () => {
    const dto = plainToInstance(SettlementBranchToHqDto, {
      branch_id: '5',
      amount: 'abc',
    });
    expect(await amountErrors(dto)).not.toHaveLength(0);
  });

  it('rejects more than 2 decimal places', async () => {
    const dto = plainToInstance(SettlementHqToMarketDto, {
      market_id: '5',
      amount: 100.123,
    });
    expect(await amountErrors(dto)).not.toHaveLength(0);
  });

  it('accepts a valid non-negative 2-dp amount', async () => {
    const dto = plainToInstance(SettlementCourierToBranchDto, {
      courier_id: '5',
      amount: 1000.5,
    });
    expect(await validate(dto)).toHaveLength(0);
  });
});
