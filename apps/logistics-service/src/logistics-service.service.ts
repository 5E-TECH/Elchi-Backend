import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Post } from './entities/post.entity';
import { Region } from './entities/region.entity';
import { District } from './entities/district.entity';

@Injectable()
export class LogisticsServiceService {
  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    @InjectRepository(Region) private readonly regionRepo: Repository<Region>,
    @InjectRepository(District) private readonly districtRepo: Repository<District>,
  ) {}

  // TODO: Post CRUD
  // TODO: Region CRUD
  // TODO: District CRUD
}
