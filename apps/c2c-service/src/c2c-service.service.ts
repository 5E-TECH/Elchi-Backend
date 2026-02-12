import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Listing } from './entities/listing.entity';
import { C2COrder } from './entities/c2c-order.entity';
import { Review } from './entities/review.entity';
import { Dispute } from './entities/dispute.entity';

@Injectable()
export class C2cServiceService {
  constructor(
    @InjectRepository(Listing) private readonly listingRepo: Repository<Listing>,
    @InjectRepository(C2COrder) private readonly c2cOrderRepo: Repository<C2COrder>,
    @InjectRepository(Review) private readonly reviewRepo: Repository<Review>,
    @InjectRepository(Dispute) private readonly disputeRepo: Repository<Dispute>,
  ) {}

  // TODO: Listing CRUD + search
  // TODO: C2COrder lifecycle
  // TODO: Review CRUD
  // TODO: Dispute management
}
