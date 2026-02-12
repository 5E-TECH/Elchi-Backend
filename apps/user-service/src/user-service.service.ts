import {
  Injectable,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserFilterQuery } from './contracts/user.payloads';

@Injectable()
export class UserServiceService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
  ) {}

  private sanitize(user: User) {
    const { password, ...safeUser } = user;
    return safeUser;
  }

  private notFound(message: string): never {
    throw new RpcException({ statusCode: 404, message });
  }

  private conflict(message: string): never {
    throw new RpcException({ statusCode: 409, message });
  }

  private normalizeQuery(query: UserFilterQuery = {}) {
    const page = Number(query.page) > 0 ? Number(query.page) : 1;
    const limit = Number(query.limit) > 0 ? Math.min(Number(query.limit), 100) : 10;

    return {
      search: query.search?.trim(),
      page,
      limit,
      skip: (page - 1) * limit,
    };
  }

  async createUser(dto: CreateUserDto) {
    const exists = await this.users.findOne({ where: { username: dto.username } });
    if (exists) {
      this.conflict('Username allaqachon mavjud');
    }

    const user = this.users.create({
      username: dto.username,
      password: await bcrypt.hash(dto.password, 10),
    });

    const saved = await this.users.save(user);
    return {
      success: true,
      message: 'User yaratildi',
      data: this.sanitize(saved),
    };
  }

  async updateUser(id: string, dto: UpdateUserDto) {
    const user = await this.users.findOne({ where: { id } });
    if (!user) {
      this.notFound('User topilmadi');
    }

    if (dto.username && dto.username !== user.username) {
      const conflict = await this.users.findOne({ where: { username: dto.username } });
      if (conflict) {
        this.conflict('Username allaqachon mavjud');
      }
      user.username = dto.username;
    }

    if (dto.password) {
      user.password = await bcrypt.hash(dto.password, 10);
    }

    const saved = await this.users.save(user);
    return {
      success: true,
      message: 'User yangilandi',
      data: this.sanitize(saved),
    };
  }

  async deleteUser(id: string) {
    const user = await this.users.findOne({ where: { id } });
    if (!user) {
      this.notFound('User topilmadi');
    }

    await this.users.delete(id);

    return {
      success: true,
      message: 'User o‘chirildi',
      data: { id },
    };
  }

  async findByUsername(username: string) {
    const user = await this.users.findOne({ where: { username } });
    if (!user) {
      this.notFound('User topilmadi');
    }

    return {
      success: true,
      data: this.sanitize(user),
    };
  }

  async findById(id: string) {
    const user = await this.users.findOne({ where: { id } });
    if (!user) {
      this.notFound('User topilmadi');
    }

    return {
      success: true,
      data: this.sanitize(user),
    };
  }

  async findAll(query: UserFilterQuery = {}) {
    const { search, page, limit, skip } = this.normalizeQuery(query);

    const where = search
      ? [
          {
            username: ILike(`%${search}%`),
          },
        ]
      : {};

    const [rows, total] = await this.users.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
      skip,
    });

    return {
      success: true,
      data: {
        items: rows.map((row) => this.sanitize(row)),
        meta: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      },
    };
  }
}
