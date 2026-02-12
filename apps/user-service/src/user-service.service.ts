import {
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Brackets, Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserFilterQuery } from './contracts/user.payloads';
import { BcryptEncryption } from './common/bcrypt.encryption';
import { Roles, Status } from '@app/common';

@Injectable()
export class UserServiceService implements OnModuleInit {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly bcryptEncryption: BcryptEncryption,
    private readonly configService: ConfigService,
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

  private async ensurePhoneUnique(phone?: string | null, exceptId?: string) {
    if (!phone) {
      return;
    }

    const found = await this.users.findOne({
      where: { phone_number: phone, is_deleted: false },
    });

    if (found && found.id !== exceptId) {
      this.conflict('Telefon raqam allaqachon mavjud');
    }
  }

  private normalizeQuery(query: UserFilterQuery = {}) {
    const page = Number(query.page) > 0 ? Number(query.page) : 1;
    const limit = Number(query.limit) > 0 ? Math.min(Number(query.limit), 100) : 10;

    return {
      search: query.search?.trim(),
      role: query.role?.trim(),
      status: query.status?.trim(),
      page,
      limit,
      skip: (page - 1) * limit,
    };
  }

  async onModuleInit() {
    try {
      const adminUsername =
        this.configService.get<string>('ADMIN_USERNAME') ?? 'superadmin';
      const adminPassword =
        this.configService.get<string>('ADMIN_PASSWORD') ?? 'superadmin123';
      const adminName = this.configService.get<string>('ADMIN_NAME') ?? 'Super Admin';
      const adminPhone =
        this.configService.get<string>('ADMIN_PHONE_NUMBER') ?? null;

      const isSuperAdmin = await this.users.findOne({
        where: { role: Roles.SUPERADMIN, is_deleted: false },
      });

      if (isSuperAdmin) {
        return;
      }

      const existingByUsername = await this.users.findOne({
        where: { username: adminUsername },
      });

      if (existingByUsername) {
        existingByUsername.name = adminName;
        existingByUsername.role = Roles.SUPERADMIN;
        existingByUsername.status = Status.ACTIVE;
        existingByUsername.is_deleted = false;
        existingByUsername.phone_number = adminPhone;
        existingByUsername.password =
          await this.bcryptEncryption.encrypt(adminPassword);
        await this.users.save(existingByUsername);
        return;
      }

      if (adminPhone) {
        const existingByPhone = await this.users.findOne({
          where: { phone_number: adminPhone },
        });

        if (existingByPhone) {
          existingByPhone.name = adminName;
          existingByPhone.role = Roles.SUPERADMIN;
          existingByPhone.status = Status.ACTIVE;
          existingByPhone.is_deleted = false;
          existingByPhone.username = adminUsername;
          existingByPhone.password =
            await this.bcryptEncryption.encrypt(adminPassword);
          await this.users.save(existingByPhone);
          return;
        }
      }

      const hashedPassword = await this.bcryptEncryption.encrypt(adminPassword);
      const superAdminUser = this.users.create({
        name: adminName,
        username: adminUsername,
        phone_number: adminPhone,
        password: hashedPassword,
        role: Roles.SUPERADMIN,
        status: Status.ACTIVE,
        is_deleted: false,
      });
      await this.users.save(superAdminUser);
    } catch (error) {
      throw new Error(`Error on init super admin: ${error}`);
    }
  }

  async createUser(dto: CreateUserDto) {
    const exists = await this.users.findOne({
      where: { username: dto.username, is_deleted: false },
    });
    if (exists) {
      this.conflict('Username allaqachon mavjud');
    }
    await this.ensurePhoneUnique(dto.phone_number);

    const user = this.users.create({
      name: dto.name ?? null,
      username: dto.username,
      phone_number: dto.phone_number ?? null,
      password: await this.bcryptEncryption.encrypt(dto.password),
      role: dto.role ?? Roles.CUSTOMER,
      status: dto.status ?? Status.ACTIVE,
      is_deleted: false,
    });

    const saved = await this.users.save(user);
    return {
      success: true,
      message: 'User yaratildi',
      data: this.sanitize(saved),
    };
  }

  async createUserForAuth(username: string, password: string, phone_number?: string) {
    const exists = await this.users.findOne({
      where: { username, is_deleted: false },
    });
    if (exists) {
      this.conflict('Username allaqachon mavjud');
    }

    await this.ensurePhoneUnique(phone_number);

    const user = this.users.create({
      username,
      phone_number: phone_number ?? null,
      password: await this.bcryptEncryption.encrypt(password),
      role: Roles.CUSTOMER,
      status: Status.ACTIVE,
      is_deleted: false,
    });

    return this.users.save(user);
  }

  async updateUser(id: string, dto: UpdateUserDto) {
    const user = await this.users.findOne({ where: { id, is_deleted: false } });
    if (!user) {
      this.notFound('User topilmadi');
    }

    if (dto.username && dto.username !== user.username) {
      const conflict = await this.users.findOne({
        where: { username: dto.username, is_deleted: false },
      });
      if (conflict) {
        this.conflict('Username allaqachon mavjud');
      }
      user.username = dto.username;
    }

    if (dto.password) {
      user.password = await this.bcryptEncryption.encrypt(dto.password);
    }

    if (dto.phone_number && dto.phone_number !== user.phone_number) {
      await this.ensurePhoneUnique(dto.phone_number, id);
      user.phone_number = dto.phone_number;
    }

    if (typeof dto.name !== 'undefined') {
      user.name = dto.name;
    }

    if (dto.role) {
      user.role = dto.role;
    }

    if (dto.status) {
      user.status = dto.status;
    }

    const saved = await this.users.save(user);
    return {
      success: true,
      message: 'User yangilandi',
      data: this.sanitize(saved),
    };
  }

  async deleteUser(id: string) {
    const user = await this.users.findOne({ where: { id, is_deleted: false } });
    if (!user) {
      this.notFound('User topilmadi');
    }

    user.is_deleted = true;
    user.status = Status.INACTIVE;
    user.username = `${user.username}#deleted#${Date.now()}`;
    if (user.phone_number) {
      user.phone_number = `${user.phone_number}#deleted#${Date.now()}`;
    }
    await this.users.save(user);

    return {
      success: true,
      message: 'User o‘chirildi',
      data: { id },
    };
  }

  async findByUsername(username: string) {
    const user = await this.users.findOne({ where: { username, is_deleted: false } });
    if (!user) {
      this.notFound('User topilmadi');
    }

    return {
      success: true,
      data: this.sanitize(user),
    };
  }

  async findByUsernameForAuth(username: string) {
    return this.users.findOne({
      where: { username, is_deleted: false, status: Status.ACTIVE },
    });
  }

  async findByPhoneForAuth(phone_number: string) {
    return this.users.findOne({
      where: { phone_number, is_deleted: false, status: Status.ACTIVE },
    });
  }

  async findById(id: string) {
    const user = await this.users.findOne({ where: { id, is_deleted: false } });
    if (!user) {
      this.notFound('User topilmadi');
    }

    return {
      success: true,
      data: this.sanitize(user),
    };
  }

  async findByIdForAuth(id: string) {
    return this.users.findOne({
      where: { id, is_deleted: false, status: Status.ACTIVE },
    });
  }

  async findAll(query: UserFilterQuery = {}) {
    const { search, role, status, page, limit, skip } = this.normalizeQuery(query);

    const qb = this.users
      .createQueryBuilder('user')
      .where('user.is_deleted = :isDeleted', { isDeleted: false });

    if (search) {
      qb.andWhere(
        new Brackets((nested) => {
          nested
            .where('user.username ILIKE :search', { search: `%${search}%` })
            .orWhere('user.name ILIKE :search', { search: `%${search}%` })
            .orWhere('user.phone_number ILIKE :search', { search: `%${search}%` });
        }),
      );
    }

    if (role) {
      qb.andWhere('user.role = :role', { role });
    }

    if (status) {
      qb.andWhere('user.status = :status', { status });
    }

    const [rows, total] = await qb
      .orderBy('user.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

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
