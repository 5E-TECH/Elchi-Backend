import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Brackets, Repository } from 'typeorm';
import { RpcException } from '@nestjs/microservices';
import { BcryptEncryption } from '../../../libs/common/helpers/bcrypt';
import { UserAdminEntity } from './entities/user.entity';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserFilterQuery } from './contracts/user.payloads';
import { Roles, Status } from '@app/common';

@Injectable()
export class UserServiceService implements OnModuleInit {
  constructor(
    @InjectRepository(UserAdminEntity)
    private readonly users: Repository<UserAdminEntity>,
    private readonly bcryptEncryption: BcryptEncryption,
    private readonly configService: ConfigService,
  ) {}

  private sanitize(user: UserAdminEntity) {
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
      role: query.role?.trim(),
      status: query.status?.trim(),
      page,
      limit,
      skip: (page - 1) * limit,
    };
  }

  private async ensurePhoneUnique(phone: string, exceptId?: string) {
    const found = await this.users.findOne({
      where: { phone_number: phone, is_deleted: false },
    });

    if (found && found.id !== exceptId) {
      this.conflict('Bu telefon raqam allaqachon mavjud');
    }
  }

  private async ensureUsernameUnique(username: string, exceptId?: string) {
    const found = await this.users.findOne({
      where: { username, is_deleted: false },
    });

    if (found && found.id !== exceptId) {
      this.conflict('Bu username allaqachon mavjud');
    }
  }

  async onModuleInit() {
    const adminName = this.configService.get<string>('SUPERADMIN_NAME') ?? 'Super Admin';
    const adminPhone = this.configService.get<string>('SUPERADMIN_PHONE_NUMBER') ?? '';
    const adminPassword = this.configService.get<string>('SUPERADMIN_PASSWORD') ?? '';

    if (!adminPhone || !adminPassword) {
      return;
    }

    const existingSuperAdmin = await this.users.findOne({
      where: { role: Roles.SUPERADMIN, is_deleted: false },
    });

    if (existingSuperAdmin) {
      return;
    }

    const existingByPhone = await this.users.findOne({
      where: { phone_number: adminPhone },
    });

    const hashedPassword = await this.bcryptEncryption.encrypt(adminPassword);

    if (existingByPhone) {
      existingByPhone.name = adminName;
      existingByPhone.role = Roles.SUPERADMIN;
      existingByPhone.status = Status.ACTIVE;
      existingByPhone.is_deleted = false;
      existingByPhone.password = hashedPassword;
      if (!existingByPhone.username) {
        existingByPhone.username = adminPhone;
      }
      await this.users.save(existingByPhone);
      return;
    }

    const superAdmin = this.users.create({
      name: adminName,
      phone_number: adminPhone,
      username: adminPhone,
      password: hashedPassword,
      salary: 0,
      payment_day: undefined,
      role: Roles.SUPERADMIN,
      status: Status.ACTIVE,
      is_deleted: false,
    });

    await this.users.save(superAdmin);
  }

  async createAdmin(dto: CreateAdminDto) {
    await this.ensurePhoneUnique(dto.phone_number);
    await this.ensureUsernameUnique(dto.phone_number);

    const hashedPassword = await this.bcryptEncryption.encrypt(dto.password);

    const admin = this.users.create({
      name: dto.name,
      phone_number: dto.phone_number,
      username: dto.phone_number,
      password: hashedPassword,
      salary: dto.salary,
      payment_day: dto.payment_day ?? new Date().getDate(),
      role: Roles.ADMIN,
      status: Status.ACTIVE,
      is_deleted: false,
    });

    const saved = await this.users.save(admin);
    return {
      success: true,
      message: 'Admin yaratildi',
      data: this.sanitize(saved),
    };
  }

  async updateAdmin(id: string, dto: UpdateUserDto) {
    const admin = await this.users.findOne({
      where: { id, is_deleted: false },
    });

    if (!admin) {
      this.notFound('Admin topilmadi');
    }

    if (dto.phone_number && dto.phone_number !== admin.phone_number) {
      await this.ensurePhoneUnique(dto.phone_number, id);
      admin.phone_number = dto.phone_number;
    }

    if (dto.username && dto.username !== admin.username) {
      await this.ensureUsernameUnique(dto.username, id);
      admin.username = dto.username;
    }

    if (dto.password) {
      admin.password = await this.bcryptEncryption.encrypt(dto.password);
    }

    if (typeof dto.name !== 'undefined') {
      admin.name = dto.name;
    }

    if (dto.role) {
      admin.role = dto.role;
    }

    if (dto.status) {
      admin.status = dto.status;
    }

    const saved = await this.users.save(admin);

    return {
      success: true,
      message: 'Admin yangilandi',
      data: this.sanitize(saved),
    };
  }

  async deleteAdmin(id: string) {
    const admin = await this.users.findOne({ where: { id, is_deleted: false } });
    if (!admin) {
      this.notFound('Admin topilmadi');
    }

    admin.is_deleted = true;
    admin.status = Status.INACTIVE;
    admin.username = `${admin.username ?? admin.phone_number}#deleted#${Date.now()}`;
    admin.phone_number = `${admin.phone_number}#deleted#${Date.now()}`;

    await this.users.save(admin);

    return {
      success: true,
      message: 'Admin o‘chirildi',
      data: { id },
    };
  }

  async findAdminById(id: string) {
    const admin = await this.users.findOne({ where: { id, is_deleted: false } });
    if (!admin) {
      this.notFound('Admin topilmadi');
    }

    return {
      success: true,
      data: this.sanitize(admin),
    };
  }

  async findAdminByUsername(username: string) {
    const admin = await this.users.findOne({
      where: { username, is_deleted: false },
    });
    if (!admin) {
      this.notFound('Admin topilmadi');
    }

    return {
      success: true,
      data: this.sanitize(admin),
    };
  }

  async findAllAdmins(query: UserFilterQuery = {}) {
    const { search, role, status, page, limit, skip } = this.normalizeQuery(query);

    const qb = this.users
      .createQueryBuilder('admin')
      .where('admin.is_deleted = :isDeleted', { isDeleted: false })
      .andWhere('admin.role IN (:...roles)', {
        roles: [Roles.SUPERADMIN, Roles.ADMIN],
      });

    if (search) {
      qb.andWhere(
        new Brackets((nested) => {
          nested
            .where('admin.name ILIKE :search', { search: `%${search}%` })
            .orWhere('admin.phone_number ILIKE :search', { search: `%${search}%` })
            .orWhere('admin.username ILIKE :search', { search: `%${search}%` });
        }),
      );
    }

    if (role) {
      qb.andWhere('admin.role = :role', { role });
    }

    if (status) {
      qb.andWhere('admin.status = :status', { status });
    }

    const [rows, total] = await qb
      .orderBy('admin.createdAt', 'DESC')
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

  async findByIdForAuth(id: string) {
    return this.users.findOne({
      where: { id, is_deleted: false, status: Status.ACTIVE },
    });
  }

  async createUserForAuth(username: string, password: string, phone_number?: string) {
    await this.ensureUsernameUnique(username);
    await this.ensurePhoneUnique(phone_number ?? username);

    const user = this.users.create({
      name: username,
      username,
      phone_number: phone_number ?? username,
      password: await this.bcryptEncryption.encrypt(password),
      salary: 0,
      payment_day: undefined,
      role: Roles.CUSTOMER,
      status: Status.ACTIVE,
      is_deleted: false,
    });

    return this.users.save(user);
  }
}
