import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './entities/user.entity';

@Injectable()
export class UserServiceService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  async createUser(username: string, password: string) {
    const user = this.users.create({ username, password });
    return this.users.save(user);
  }

  async findByUsername(username: string) {
    return this.users.findOne({ where: { username } });
  }

  async findById(id: string) {
    return this.users.findOne({ where: { id } });
  }
}
