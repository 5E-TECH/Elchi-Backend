import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cashbox } from './entities/cashbox.entity';
import { CashboxHistory } from './entities/cashbox-history.entity';
import { Shift } from './entities/shift.entity';
import { UserSalary } from './entities/user-salary.entity';

@Injectable()
export class FinanceServiceService {
  constructor(
    @InjectRepository(Cashbox) private readonly cashboxRepo: Repository<Cashbox>,
    @InjectRepository(CashboxHistory) private readonly historyRepo: Repository<CashboxHistory>,
    @InjectRepository(Shift) private readonly shiftRepo: Repository<Shift>,
    @InjectRepository(UserSalary) private readonly salaryRepo: Repository<UserSalary>,
  ) {}

  // TODO: Cashbox CRUD + balance operations
  // TODO: CashboxHistory operations
  // TODO: Shift open/close
  // TODO: UserSalary CRUD
}
