import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Investor } from './entities/investor.entity';
import { Investment } from './entities/investment.entity';
import { ProfitShare } from './entities/profit-share.entity';

@Injectable()
export class InvestorServiceService {
  constructor(
    @InjectRepository(Investor) private readonly investorRepo: Repository<Investor>,
    @InjectRepository(Investment) private readonly investmentRepo: Repository<Investment>,
    @InjectRepository(ProfitShare) private readonly profitShareRepo: Repository<ProfitShare>,
  ) {}

  // TODO: Investor CRUD
  // TODO: Investment CRUD
  // TODO: ProfitShare calculation & CRUD
}
