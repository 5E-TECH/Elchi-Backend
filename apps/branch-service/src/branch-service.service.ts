import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Branch } from './entities/branch.entity';
import { BranchUser } from './entities/branch-user.entity';
import { BranchConfig } from './entities/branch-config.entity';

@Injectable()
export class BranchServiceService {
  constructor(
    @InjectRepository(Branch) private readonly branchRepo: Repository<Branch>,
    @InjectRepository(BranchUser) private readonly branchUserRepo: Repository<BranchUser>,
    @InjectRepository(BranchConfig) private readonly branchConfigRepo: Repository<BranchConfig>,
  ) {}

  // TODO: Branch CRUD
  // TODO: BranchUser assign/remove
  // TODO: BranchConfig CRUD
}
