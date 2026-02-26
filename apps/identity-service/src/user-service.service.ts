import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Brackets, In, Repository } from 'typeorm';
import { RpcException } from '@nestjs/microservices';
import { BcryptEncryption } from '../../../libs/common/helpers/bcrypt';
import { UserAdminEntity } from './entities/user.entity';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateMarketDto } from './dto/create-market.dto';
import { UpdateMarketDto } from './dto/update-market.dto';
import { CreateCourierDto } from './dto/create-courier.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UserFilterQuery } from './contracts/user.payloads';
import { Roles, Status } from '@app/common';
import { catchError } from '../../../libs/common/helpers/response';

@Injectable()
export class UserServiceService implements OnModuleInit {
  constructor(
    @InjectRepository(UserAdminEntity)
    private readonly users: Repository<UserAdminEntity>,
    private readonly bcryptEncryption: BcryptEncryption,
    private readonly configService: ConfigService,
  ) {}

  private sanitize(user: UserAdminEntity) {
    const { password, refresh_token, ...safeUser } = user;
    return safeUser;
  }

  private notFound(message: string): never {
    throw new RpcException({ statusCode: 404, message });
  }

  private badRequest(message: string): never {
    throw new RpcException({ statusCode: 400, message });
  }

  private conflict(message: string): never {
    throw new RpcException({ statusCode: 409, message });
  }

  private readonly adminRoles: Roles[] = [Roles.SUPERADMIN, Roles.ADMIN];

  private ensureRoleIsAdmin(role: Roles) {
    if (!this.adminRoles.includes(role)) {
      this.badRequest('Admin endpoint orqali faqat admin yoki superadmin roli berilishi mumkin');
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
    const config = {
      ADMIN_NAME: this.configService.get<string>('SUPERADMIN_NAME'),
      ADMIN_PHONE_NUMBER: this.configService.get<string>('SUPERADMIN_PHONE_NUMBER'),
      ADMIN_PASSWORD: this.configService.get<string>('SUPERADMIN_PASSWORD'),
    };

    if (!config.ADMIN_NAME || !config.ADMIN_PHONE_NUMBER || !config.ADMIN_PASSWORD) {
      throw new RpcException({
        statusCode: 500,
        message:
          'SUPERADMIN_NAME, SUPERADMIN_PHONE_NUMBER, SUPERADMIN_PASSWORD .env da bo‘lishi shart',
      });
    }

    try {
      const isSuperAdmin = await this.users.findOne({
        where: { role: Roles.SUPERADMIN, is_deleted: false },
      });

      if (!isSuperAdmin) {
        const hashedPassword = await this.bcryptEncryption.encrypt(
          config.ADMIN_PASSWORD,
        );
        const superAdminThis = this.users.create({
          name: config.ADMIN_NAME,
          phone_number: config.ADMIN_PHONE_NUMBER,
          username: config.ADMIN_PHONE_NUMBER,
          password: hashedPassword,
          role: Roles.SUPERADMIN,
          status: Status.ACTIVE,
          is_deleted: false,
        });
        await this.users.save(superAdminThis);
      }
    } catch (error) {
      return catchError(error);
    }
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
    return this.updateUser(id, dto);
  }

  async updateUser(id: string, dto: UpdateUserDto) {
    const admin = await this.users.findOne({
      where: { id, is_deleted: false },
    });

    if (!admin) {
      this.notFound('User topilmadi');
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

    if (dto.status) {
      admin.status = dto.status;
    }

    if (typeof dto.salary !== 'undefined') {
      admin.salary = dto.salary;
    }

    if (typeof dto.payment_day !== 'undefined') {
      admin.payment_day = dto.payment_day;
    }

    if (typeof dto.tariff_home !== 'undefined') {
      admin.tariff_home = dto.tariff_home;
    }

    if (typeof dto.tariff_center !== 'undefined') {
      admin.tariff_center = dto.tariff_center;
    }

    if (typeof dto.add_order !== 'undefined') {
      admin.add_order = dto.add_order;
    }

    if (typeof dto.default_tariff !== 'undefined') {
      admin.default_tariff = dto.default_tariff;
    }

    const saved = await this.users.save(admin);
    return {
      success: true,
      message: 'User yangilandi',
      data: this.sanitize(saved),
    };
  }

  async deleteAdmin(id: string) {
    return this.deleteUser(id);
  }

  async deleteUser(id: string) {
    const admin = await this.users.findOne({
      where: { id, is_deleted: false },
    });
    if (!admin) {
      this.notFound('User topilmadi');
    }

    const ts = Date.now();
    const deletedPhone = `${admin.phone_number}-d${ts % 100000}`.slice(0, 20);
    const deletedUsername =
      admin.username?.length
        ? `${admin.username}#del#${ts % 100000}`.slice(0, 60)
        : null;

    admin.is_deleted = true;
    admin.status = Status.INACTIVE;
    admin.username = deletedUsername;
    admin.phone_number = deletedPhone;

    await this.users.save(admin);

    return {
      success: true,
      message: 'User o‘chirildi',
      data: { id },
    };
  }

  async findUserById(id: string) {
    const user = await this.users.findOne({
      where: { id, is_deleted: false },
    });
    if (!user) {
      this.notFound('User topilmadi');
    }

    return {
      success: true,
      data: this.sanitize(user),
    };
  }

  async findCustomerById(id: string) {
    const user = await this.users.findOne({
      where: { id, role: Roles.CUSTOMER, is_deleted: false },
    });
    if (!user) {
      this.notFound('Customer topilmadi');
    }

    return {
      success: true,
      data: this.sanitize(user),
    };
  }

  async findAdminById(id: string) {
    return this.findUserById(id);
  }

  async findAllAdmins(query: UserFilterQuery = {}) {
    const { search, role, status, page, limit, skip } = this.normalizeQuery(query);

    const qb = this.users
      .createQueryBuilder('admin')
      .where('admin.is_deleted = :isDeleted', { isDeleted: false })
      .andWhere('admin.role != :superadminRole', { superadminRole: Roles.SUPERADMIN })
      .andWhere('admin.role != :customerRole', { customerRole: Roles.CUSTOMER });

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

  async findAllCouriers(query: UserFilterQuery = {}) {
    const { search, status, page, limit, skip } = this.normalizeQuery(query);

    const qb = this.users
      .createQueryBuilder('courier')
      .where('courier.is_deleted = :isDeleted', { isDeleted: false })
      .andWhere('courier.role = :role', { role: Roles.COURIER });

    if (search) {
      qb.andWhere(
        new Brackets((nested) => {
          nested
            .where('courier.name ILIKE :search', { search: `%${search}%` })
            .orWhere('courier.phone_number ILIKE :search', { search: `%${search}%` })
            .orWhere('courier.username ILIKE :search', { search: `%${search}%` });
        }),
      );
    }

    if (status) {
      qb.andWhere('courier.status = :status', { status });
    }

    const [rows, total] = await qb
      .orderBy('courier.createdAt', 'DESC')
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

  async createMarket(dto: CreateMarketDto) {
    await this.ensurePhoneUnique(dto.phone_number);
    await this.ensureUsernameUnique(dto.username);

    const hashedPassword = await this.bcryptEncryption.encrypt(dto.password);

    const market = this.users.create({
      name: dto.name,
      phone_number: dto.phone_number,
      username: dto.username,
      password: hashedPassword,
      salary: 0,
      payment_day: undefined,
      role: Roles.MARKET,
      status: Status.ACTIVE,
      tariff_home: dto.tariff_home,
      tariff_center: dto.tariff_center,
      add_order: dto.add_order ?? false,
      default_tariff: dto.default_tariff,
      is_deleted: false,
    });

    const saved = await this.users.save(market);
    return {
      success: true,
      message: 'Market yaratildi',
      data: this.sanitize(saved),
    };
  }

  async createCourier(dto: CreateCourierDto) {
    await this.ensurePhoneUnique(dto.phone_number);
    await this.ensureUsernameUnique(dto.phone_number);

    const hashedPassword = await this.bcryptEncryption.encrypt(dto.password);

    const courier = this.users.create({
      name: dto.name,
      phone_number: dto.phone_number,
      username: dto.phone_number,
      password: hashedPassword,
      salary: 0,
      payment_day: undefined,
      role: Roles.COURIER,
      status: Status.ACTIVE,
      tariff_home: dto.tariff_home,
      tariff_center: dto.tariff_center,
      add_order: false,
      default_tariff: null,
      is_deleted: false,
    });

    const saved = await this.users.save(courier);
    return {
      success: true,
      message: 'Courier yaratildi',
      data: this.sanitize(saved),
    };
  }

  async createCustomer(dto: CreateCustomerDto) {
    const existing = await this.users.findOne({
      where: { phone_number: dto.phone_number, is_deleted: false },
    });

    if (existing) {
      if (existing.role !== Roles.CUSTOMER) {
        this.conflict('Bu telefon raqam boshqa rolda allaqachon mavjud');
      }

      return {
        success: true,
        message: 'Customer allaqachon mavjud',
        data: this.sanitize(existing),
      };
    }

    const generatedPassword = `cust_${Math.random().toString(36).slice(2, 12)}`;
    const customer = this.users.create({
      name: dto.name,
      phone_number: dto.phone_number,
      extra_number: dto.extra_number ?? null,
      username: dto.phone_number,
      password: await this.bcryptEncryption.encrypt(generatedPassword),
      salary: 0,
      payment_day: undefined,
      role: Roles.CUSTOMER,
      status: Status.ACTIVE,
      tariff_home: null,
      tariff_center: null,
      add_order: false,
      default_tariff: null,
      is_deleted: false,
    });

    const saved = await this.users.save(customer);
    return {
      success: true,
      message: 'Customer yaratildi',
      data: this.sanitize(saved),
    };
  }

  async updateMarket(id: string, dto: UpdateMarketDto) {
    const market = await this.users.findOne({
      where: { id, role: Roles.MARKET, is_deleted: false },
    });

    if (!market) {
      this.notFound('Market topilmadi');
    }

    if (dto.phone_number && dto.phone_number !== market.phone_number) {
      await this.ensurePhoneUnique(dto.phone_number, id);
      market.phone_number = dto.phone_number;
    }

    if (dto.password) {
      market.password = await this.bcryptEncryption.encrypt(dto.password);
    }

    if (typeof dto.name !== 'undefined') {
      market.name = dto.name;
    }

    if (typeof dto.status !== 'undefined') {
      market.status = dto.status;
    }

    if (typeof dto.tariff_home !== 'undefined') {
      market.tariff_home = dto.tariff_home;
    }

    if (typeof dto.tariff_center !== 'undefined') {
      market.tariff_center = dto.tariff_center;
    }

    if (typeof dto.default_tariff !== 'undefined') {
      market.default_tariff = dto.default_tariff;
    }

    if (typeof dto.add_order !== 'undefined') {
      market.add_order = dto.add_order;
    }

    const saved = await this.users.save(market);
    return {
      success: true,
      message: 'Market yangilandi',
      data: this.sanitize(saved),
    };
  }

  async deleteMarket(id: string) {
    const market = await this.users.findOne({
      where: { id, role: Roles.MARKET, is_deleted: false },
    });
    if (!market) {
      this.notFound('Market topilmadi');
    }

    const ts = Date.now();
    const deletedPhone = `${market.phone_number}-d${ts % 100000}`.slice(0, 20);
    const deletedUsername =
      market.username?.length
        ? `${market.username}#del#${ts % 100000}`.slice(0, 60)
        : null;

    market.is_deleted = true;
    market.status = Status.INACTIVE;
    market.username = deletedUsername;
    market.phone_number = deletedPhone;

    await this.users.save(market);

    return {
      success: true,
      message: 'Market o‘chirildi',
      data: { id },
    };
  }

  async findMarketById(id: string) {
    return this.findUserById(id);
  }

  async findAllMarkets(query: UserFilterQuery = {}) {
    const { search, status, page, limit, skip } = this.normalizeQuery(query);

    const qb = this.users
      .createQueryBuilder('market')
      .where('market.is_deleted = :isDeleted', { isDeleted: false })
      .andWhere('market.role = :role', { role: Roles.MARKET });

    if (search) {
      qb.andWhere(
        new Brackets((nested) => {
          nested
            .where('market.name ILIKE :search', { search: `%${search}%` })
            .orWhere('market.phone_number ILIKE :search', { search: `%${search}%` })
            .orWhere('market.username ILIKE :search', { search: `%${search}%` });
        }),
      );
    }

    if (status) {
      qb.andWhere('market.status = :status', { status });
    }

    const [rows, total] = await qb
      .orderBy('market.createdAt', 'DESC')
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

  async setUserStatus(id: string, status: Status) {
    const user = await this.users.findOne({
      where: { id, is_deleted: false },
    });

    if (!user) {
      this.notFound('User topilmadi');
    }

    user.status = status;
    const saved = await this.users.save(user);

    return {
      success: true,
      message: 'User status yangilandi',
      data: this.sanitize(saved),
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
