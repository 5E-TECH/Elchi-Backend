import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Brackets, In, Repository } from 'typeorm';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';
import { BcryptEncryption } from '../../../libs/common/helpers/bcrypt';
import { User } from './entities/user.entity';
import { CreateAdminDto } from './dto/create-admin.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateMarketDto } from './dto/create-market.dto';
import { UpdateMarketDto } from './dto/update-market.dto';
import { CreateCourierDto } from './dto/create-courier.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UserFilterQuery } from './contracts/user.payloads';
import { Cashbox_type, Roles, Status, rmqSend } from '@app/common';
import { catchError, errorRes, successRes } from '../../../libs/common/helpers/response';
import { RequesterContext } from './contracts/user.payloads';

@Injectable()
export class UserServiceService implements OnModuleInit {
  constructor(
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @Inject('SEARCH') private readonly searchClient: ClientProxy,
    @Inject('CATALOG') private readonly catalogClient: ClientProxy,
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    @Inject('LOGISTICS') private readonly logisticsClient: ClientProxy,
    @Inject('FINANCE') private readonly financeClient: ClientProxy,
    private readonly bcryptEncryption: BcryptEncryption,
    private readonly configService: ConfigService,
  ) {}

  private sanitize(user: User) {
    const { password, refresh_token, ...safeUser } = user;
    return safeUser;
  }

  private notFound(message: string): never {
    throw new RpcException(errorRes(message, 404));
  }

  private badRequest(message: string): never {
    throw new RpcException(errorRes(message, 400));
  }

  private conflict(message: string): never {
    throw new RpcException(errorRes(message, 409));
  }

  private forbidden(message: string): never {
    throw new RpcException(errorRes(message, 403));
  }

  private hasRole(requester: RequesterContext | undefined, role: Roles): boolean {
    return requester?.roles?.includes(role) ?? false;
  }

  private assertRequesterCanCreateAdmin(requester?: RequesterContext) {
    if (!requester) {
      return;
    }

    if (this.hasRole(requester, Roles.SUPERADMIN)) {
      return;
    }

    if (this.hasRole(requester, Roles.ADMIN)) {
      this.forbidden('Admin admin yarata olmaydi');
    }

    this.forbidden('Bu amal uchun ruxsat yoq');
  }

  private assertRequesterCanMutateUser(
    requester: RequesterContext | undefined,
    targetRole: Roles,
  ) {
    if (!requester) {
      return;
    }

    if (this.hasRole(requester, Roles.SUPERADMIN)) {
      return;
    }

    if (this.hasRole(requester, Roles.ADMIN)) {
      if (targetRole === Roles.SUPERADMIN || targetRole === Roles.ADMIN) {
        this.forbidden('Admin admin yoki superadminni boshqara olmaydi');
      }
      return;
    }

    this.forbidden('Bu amal uchun ruxsat yoq');
  }

  private normalizeQuery(query: UserFilterQuery = {}) {
    const page = Number(query.page) > 0 ? Number(query.page) : 1;
    const limit = Number(query.limit) > 0 ? Math.min(Number(query.limit), 100) : 10;

    return {
      search: query.search?.trim(),
      role: query.role?.trim(),
      status: query.status?.trim(),
      region_id: query.region_id?.trim(),
      page,
      limit,
      skip: (page - 1) * limit,
    };
  }

  private async ensurePhoneUnique(phone: string, exceptId?: string) {
    const found = await this.users.findOne({
      where: { phone_number: phone, isDeleted: false },
    });

    if (found && found.id !== exceptId) {
      this.conflict('Bu telefon raqam allaqachon mavjud');
    }
  }

  private async ensureUsernameUnique(username: string, exceptId?: string) {
    const found = await this.users.findOne({
      where: { username, isDeleted: false },
    });

    if (found && found.id !== exceptId) {
      this.conflict('Bu username allaqachon mavjud');
    }
  }

  private async validateRegionExists(regionId: string): Promise<void> {
    try {
      const res = await lastValueFrom(
        this.logisticsClient
          .send({ cmd: 'logistics.region.find_by_id' }, { id: regionId })
          .pipe(timeout(5000)),
      );
      const region = res?.data ?? res ?? null;
      if (!region) {
        this.badRequest('Region not found');
      }
    } catch {
      this.badRequest('Region not found');
    }
  }

  private async getRegionsByIds(regionIds: string[]): Promise<Map<string, unknown>> {
    if (!regionIds.length) {
      return new Map();
    }

    const resolved = await Promise.all(
      regionIds.map(async (id) => {
        try {
          const res = await lastValueFrom(
            this.logisticsClient
              .send({ cmd: 'logistics.region.find_by_id' }, { id })
              .pipe(timeout(5000)),
          );
          const region = this.stripRegionDistricts(res?.data ?? res ?? null);
          return [id, region] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    );

    return new Map(resolved);
  }

  private async getRegionById(regionId?: string | null): Promise<unknown | null> {
    if (!regionId) {
      return null;
    }

    try {
      const res = await lastValueFrom(
        this.logisticsClient
          .send({ cmd: 'logistics.region.find_by_id' }, { id: regionId })
          .pipe(timeout(5000)),
      );
      return this.stripRegionDistricts(res?.data ?? res ?? null);
    } catch {
      return null;
    }
  }

  private stripRegionDistricts<T>(region: T): T {
    if (!region || typeof region !== 'object') {
      return region;
    }

    const { districts, ...rest } = region as Record<string, unknown>;
    return rest as T;
  }

  private async syncUserToSearch(user: User): Promise<void> {
    try {
      const safe = this.sanitize(user) as User;
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.upsert' },
            {
              source: 'identity',
              type: safe.role,
              sourceId: safe.id,
              title: safe.name,
              content: [safe.phone_number, safe.username].filter(Boolean).join(' '),
              tags: ['identity', safe.role, safe.status].filter(Boolean),
              metadata: {
                role: safe.role,
                status: safe.status,
                phone_number: safe.phone_number,
                username: safe.username,
                region_id: safe.region_id,
                isDeleted: safe.isDeleted,
              },
            },
          )
          .pipe(timeout(1500)),
      );
    } catch {
      // Search sync should not block identity flows.
    }
  }

  private async removeUserFromSearch(user: User): Promise<void> {
    try {
      await lastValueFrom(
        this.searchClient
          .send(
            { cmd: 'search.index.remove' },
            { source: 'identity', type: user.role, sourceId: user.id },
          )
          .pipe(timeout(1500)),
      );
    } catch {
      // Search sync should not block identity flows.
    }
  }

  private async ensureUserCashbox(userId: string, cashboxType: Cashbox_type) {
    try {
      await rmqSend(
        this.financeClient,
        { cmd: 'finance.cashbox.create' },
        {
          user_id: userId,
          cashbox_type: cashboxType,
          balance_cash: 0,
          balance_card: 0,
        },
      );
    } catch (error) {
      if (error instanceof RpcException) {
        const payload = (error as any).error;
        const message =
          typeof payload === 'object' && payload?.message ? String(payload.message) : error.message;
        if (message.includes('Cashbox already exists')) {
          return;
        }
      }
      throw error;
    }
  }

  async onModuleInit() {
    const config = {
      ADMIN_NAME: this.configService.get<string>('SUPERADMIN_NAME'),
      ADMIN_PHONE_NUMBER: this.configService.get<string>('SUPERADMIN_PHONE_NUMBER'),
      ADMIN_PASSWORD: this.configService.get<string>('SUPERADMIN_PASSWORD'),
    };

    if (!config.ADMIN_NAME || !config.ADMIN_PHONE_NUMBER || !config.ADMIN_PASSWORD) {
      throw new RpcException(
        errorRes(
          'SUPERADMIN_NAME, SUPERADMIN_PHONE_NUMBER, SUPERADMIN_PASSWORD .env da bo‘lishi shart',
          500,
        ),
      );
    }

    try {
      const isSuperAdmin = await this.users.findOne({
        where: { role: Roles.SUPERADMIN, isDeleted: false },
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
          isDeleted: false,
        });
        const savedSuperAdmin = await this.users.save(superAdminThis);
        void this.syncUserToSearch(savedSuperAdmin);
      }
    } catch (error) {
      return catchError(error);
    }
  }

  async createAdmin(dto: CreateAdminDto, requester?: RequesterContext) {
    this.assertRequesterCanCreateAdmin(requester);

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
      isDeleted: false,
    });

    const saved = await this.users.save(admin);
    void this.syncUserToSearch(saved);
    return successRes(this.sanitize(saved), 201, 'Admin yaratildi');
  }

  async updateAdmin(id: string, dto: UpdateUserDto) {
    return this.updateUser(id, dto);
  }

  async updateUser(id: string, dto: UpdateUserDto, requester?: RequesterContext) {
    const admin = await this.users.findOne({
      where: { id, isDeleted: false },
    });

    if (!admin) {
      this.notFound('User topilmadi');
    }
    this.assertRequesterCanMutateUser(requester, admin.role);

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
    void this.syncUserToSearch(saved);
    return successRes(this.sanitize(saved), 200, 'User yangilandi');
  }

  async deleteAdmin(id: string) {
    return this.deleteUser(id);
  }

  async deleteUser(id: string, requester?: RequesterContext) {
    const admin = await this.users.findOne({
      where: { id, isDeleted: false },
    });
    if (!admin) {
      this.notFound('User topilmadi');
    }
    this.assertRequesterCanMutateUser(requester, admin.role);

    if (admin.role === Roles.SUPERADMIN) {
      this.badRequest('Superadminni o‘chirib bo‘lmaydi');
    }

    if (admin.role === Roles.MARKET) {
      try {
        await lastValueFrom(
          this.catalogClient
            .send({ cmd: 'catalog.product.delete_by_market' }, { user_id: admin.id })
            .pipe(timeout(5000)),
        );
      } catch {
        throw new RpcException(
          errorRes('Marketga tegishli productlarni o‘chirishda xatolik', 502),
        );
      }
    }

    const ts = Date.now();
    const deletedPhone = `${admin.phone_number}-d${ts % 100000}`.slice(0, 20);
    const deletedUsername =
      admin.username?.length
        ? `${admin.username}#del#${ts % 100000}`.slice(0, 60)
        : null;

    admin.isDeleted = true;
    admin.status = Status.INACTIVE;
    admin.username = deletedUsername;
    admin.phone_number = deletedPhone;

    const saved = await this.users.save(admin);
    void this.removeUserFromSearch(saved);

    return successRes({ id }, 200, 'User o‘chirildi');
  }

  async findUserById(id: string) {
    const user = await this.users.findOne({
      where: { id, isDeleted: false },
    });
    if (!user) {
      this.notFound('User topilmadi');
    }

    const safeUser = this.sanitize(user);
    const profileRegion = await this.getRegionById(safeUser.region_id);

    if (safeUser.role !== Roles.CUSTOMER) {
      return successRes({
        ...safeUser,
        region: profileRegion,
      });
    }

    try {
      const orders = await lastValueFrom(
        this.orderClient
          .send(
            { cmd: 'order.find_all' },
            {
              query: {
                customer_id: safeUser.id,
                page: 1,
                limit: 1000,
              },
            },
          )
          .pipe(timeout(5000)),
      );

      const customerOrders = orders?.data ?? [];
      const latestAddressOrder = customerOrders.find(
        (order: { address?: string | null }) => Boolean(order?.address),
      ) as
        | {
            address?: string | null;
            district_id?: string | null;
            region_id?: string | null;
          }
        | undefined;

      return successRes({
        ...safeUser,
        address: latestAddressOrder?.address ?? null,
        district_id: latestAddressOrder?.district_id ?? null,
        region_id: latestAddressOrder?.region_id ?? null,
        region: latestAddressOrder?.region_id
          ? (await this.getRegionById(latestAddressOrder.region_id))
          : profileRegion,
        orders: customerOrders,
      });
    } catch {
      throw new RpcException(
        errorRes('Customer orderlarini olishda xatolik', 502),
      );
    }
  }

  async findCustomerById(id: string) {
    const user = await this.users.findOne({
      where: { id, role: Roles.CUSTOMER, isDeleted: false },
    });
    if (!user) {
      this.notFound('Customer topilmadi');
    }

    return successRes(this.sanitize(user));
  }

  async findAdminById(id: string) {
    return this.findUserById(id);
  }

  async findAllAdmins(query: UserFilterQuery = {}) {
    const { search, role, status, page, limit, skip } = this.normalizeQuery(query);

    const qb = this.users
      .createQueryBuilder('admin')
      .where('admin.isDeleted = :isDeleted', { isDeleted: false })
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

    return successRes({
      items: rows.map((row) => this.sanitize(row)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  }

  async findAllCouriers(query: UserFilterQuery = {}) {
    const { search, status, region_id, page, limit, skip } = this.normalizeQuery(query);

    const qb = this.users
      .createQueryBuilder('courier')
      .where('courier.isDeleted = :isDeleted', { isDeleted: false })
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

    if (region_id) {
      qb.andWhere('courier.region_id = :region_id', { region_id });
    }

    const [rows, total] = await qb
      .orderBy('courier.createdAt', 'DESC')
      .skip(skip)
      .take(limit)
      .getManyAndCount();

    const regionIds = Array.from(
      new Set(
        rows
          .map((row) => row.region_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
    const regionsById = await this.getRegionsByIds(regionIds);

    return successRes({
      items: rows.map((row) => ({
        ...this.sanitize(row),
        region: row.region_id ? regionsById.get(row.region_id) ?? null : null,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
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
      isDeleted: false,
    });

    const saved = await this.users.save(market);
    await this.ensureUserCashbox(saved.id, Cashbox_type.FOR_MARKET);
    void this.syncUserToSearch(saved);
    return successRes(this.sanitize(saved), 201, 'Market yaratildi');
  }

  async createCourier(dto: CreateCourierDto) {
    await this.validateRegionExists(dto.region_id);
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
      region_id: dto.region_id,
      role: Roles.COURIER,
      status: Status.ACTIVE,
      tariff_home: dto.tariff_home,
      tariff_center: dto.tariff_center,
      add_order: false,
      default_tariff: null,
      isDeleted: false,
    });

    const saved = await this.users.save(courier);
    await this.ensureUserCashbox(saved.id, Cashbox_type.FOR_COURIER);
    void this.syncUserToSearch(saved);
    return successRes(this.sanitize(saved), 201, 'Courier yaratildi');
  }

  async createCustomer(dto: CreateCustomerDto) {
    const existing = await this.users.findOne({
      where: [
        { phone_number: dto.phone_number, isDeleted: false },
        { username: dto.phone_number, isDeleted: false },
      ],
    });

    if (existing) {
      if (existing.role !== Roles.CUSTOMER) {
        this.conflict('Bu telefon raqam boshqa rolda allaqachon mavjud');
      }

      return successRes(this.sanitize(existing), 200, 'Customer allaqachon mavjud');
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
      isDeleted: false,
    });

    const saved = await this.users.save(customer);
    void this.syncUserToSearch(saved);
    return successRes(this.sanitize(saved), 201, 'Customer yaratildi');
  }

  async updateMarket(id: string, dto: UpdateMarketDto) {
    const market = await this.users.findOne({
      where: { id, role: Roles.MARKET, isDeleted: false },
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
    void this.syncUserToSearch(saved);
    return successRes(this.sanitize(saved), 200, 'Market yangilandi');
  }

  async deleteMarket(id: string) {
    const market = await this.users.findOne({
      where: { id, role: Roles.MARKET, isDeleted: false },
    });
    if (!market) {
      this.notFound('Market topilmadi');
    }

    try {
      await lastValueFrom(
        this.catalogClient
          .send({ cmd: 'catalog.product.delete_by_market' }, { user_id: id })
          .pipe(timeout(5000)),
      );
    } catch {
      throw new RpcException(
        errorRes('Marketga tegishli productlarni o‘chirishda xatolik', 502),
      );
    }

    const ts = Date.now();
    const deletedPhone = `${market.phone_number}-d${ts % 100000}`.slice(0, 20);
    const deletedUsername =
      market.username?.length
        ? `${market.username}#del#${ts % 100000}`.slice(0, 60)
        : null;

    market.isDeleted = true;
    market.status = Status.INACTIVE;
    market.username = deletedUsername;
    market.phone_number = deletedPhone;

    const saved = await this.users.save(market);
    void this.removeUserFromSearch(saved);

    return successRes({ id }, 200, 'Market o‘chirildi');
  }

  async findMarketById(id: string) {
    const market = await this.users.findOne({
      where: { id, role: Roles.MARKET, isDeleted: false },
    });
    if (!market) {
      this.notFound('Market topilmadi yoki faol emas');
    }

    return {
      success: true,
      data: this.sanitize(market),
    };
  }

  async findMarketsByIds(ids: string[]) {
    if (!ids.length) {
      return { success: true, data: [] };
    }

    const markets = await this.users.find({
      where: {
        id: In(ids),
        role: Roles.MARKET,
        isDeleted: false,
      },
    });

    return {
      success: true,
      data: markets.map((m) => this.sanitize(m)),
    };
  }

  async findAllMarkets(query: UserFilterQuery = {}) {
    const { search, status, page, limit, skip } = this.normalizeQuery(query);

    const qb = this.users
      .createQueryBuilder('market')
      .where('market.isDeleted = :isDeleted', { isDeleted: false })
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

    return successRes({
      items: rows.map((row) => this.sanitize(row)),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  }

  async setUserStatus(
    id: string,
    status: Status,
    requester?: RequesterContext,
  ) {
    const user = await this.users.findOne({
      where: { id, isDeleted: false },
    });

    if (!user) {
      this.notFound('User topilmadi');
    }
    this.assertRequesterCanMutateUser(requester, user.role);

    user.status = status;
    const saved = await this.users.save(user);
    void this.syncUserToSearch(saved);

    return successRes(this.sanitize(saved), 200, 'User status yangilandi');
  }

  async findCustomersByIds(ids: string[]) {
    if (!ids.length) {
      return { success: true, data: [] };
    }

    const customers = await this.users.find({
      where: {
        id: In(ids),
        role: Roles.CUSTOMER,
        isDeleted: false,
      },
    });

    return {
      success: true,
      data: customers.map((c) => this.sanitize(c)),
    };
  }

  async findCouriersByIds(ids: string[]) {
    if (!ids.length) {
      return { success: true, data: [] };
    }

    const couriers = await this.users.find({
      where: {
        id: In(ids),
        role: Roles.COURIER,
        isDeleted: false,
      },
    });

    return {
      success: true,
      data: couriers.map((c) => this.sanitize(c)),
    };
  }

  async searchCustomers(search: string, limit = 1000) {
    if (!search?.trim()) {
      return { success: true, data: [] };
    }

    const qb = this.users
      .createQueryBuilder('u')
      .where('u.isDeleted = :isDeleted', { isDeleted: false })
      .andWhere('u.role = :role', { role: Roles.CUSTOMER })
      .andWhere(
        new Brackets((q) => {
          q.where('u.name ILIKE :s', { s: `%${search.trim()}%` }).orWhere(
            'u.phone_number ILIKE :s',
            { s: `%${search.trim()}%` },
          );
        }),
      )
      .take(limit);

    const rows = await qb.getMany();
    return {
      success: true,
      data: rows.map((r) => this.sanitize(r)),
    };
  }

  async findByUsernameForAuth(username: string) {
    return this.users.findOne({
      where: { username, isDeleted: false, status: Status.ACTIVE },
    });
  }

  async findByPhoneForAuth(phone_number: string) {
    return this.users.findOne({
      where: { phone_number, isDeleted: false, status: Status.ACTIVE },
    });
  }

  async findByIdForAuth(id: string) {
    return this.users.findOne({
      where: { id, isDeleted: false, status: Status.ACTIVE },
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
      isDeleted: false,
    });

    const saved = await this.users.save(user);
    void this.syncUserToSearch(saved);
    return saved;
  }
}
