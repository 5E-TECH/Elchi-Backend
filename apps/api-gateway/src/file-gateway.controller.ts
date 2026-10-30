import {
  Body,
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Optional,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiForbiddenResponse,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { Public } from './auth/public.decorator';
import { RolesGuard } from './auth/roles.guard';
import { Roles } from './auth/roles.decorator';
import { Roles as RoleEnum } from '@app/common';
import {
  GeneratePdfRequestDto,
  GenerateQrRequestDto,
} from './dto/file.swagger.dto';
import type { Response } from 'express';
import { matchesDeclaredType } from '@app/common';
import {
  assertFolderAllowed,
  assertUploadFits,
  canonicalUploadFolder,
  DEFAULT_UPLOAD_FOLDER,
  UPLOAD_FOLDERS,
  UPLOAD_MULTER_MAX_BYTES,
  UPLOAD_ROLES,
  uploadPolicySwaggerDescription,
} from './file-upload-policy';
import { isFileLinkKey, readFileLinkToken } from './file-link';
import {
  fileOwnerOf,
  fileOwnershipEnforced,
  isOrderInBranch,
  isOrderParticipant,
  type FileOwnerRecord,
  type ProofOrderOwner,
} from './file-ownership';

// RPC ceiling: this downstream can legitimately run long (base64/provider
// fetch up to ~60s); an 8s ceiling would premature-fail a working call. See
// integration-service AbortSignal.timeout / file base64 transfer.
const FILE_RPC_TIMEOUT_MS = 60_000;

type PrivateFileRequest = {
  user?: { sub?: string; roles?: string[]; branch_id?: string | null };
};

const PRIVATE_FILE_FORBIDDEN_DESCRIPTION =
  "Maxfiy faylga ruxsat yo'q (rol yoki egalik): reestrdagi fayl — yuklagan foydalanuvchi, buyurtma ishtirokchisi, shu filial yoki HQ xodimi, admin.";

@ApiTags('File')
@ApiBearerAuth()
@Controller()
export class FileGatewayController {
  private readonly allowedMime = new Set<string>([
    'image/png',
    'image/jpeg',
    'image/jpg',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'video/mp4',
    'video/quicktime',
    'video/webm',
  ]);

  constructor(
    @Inject('FILE') private readonly fileClient: ClientProxy,
    // Dalil faylining egasini aniqlash uchun (audit S5).
    @Inject('ORDER') private readonly orderClient: ClientProxy,
    // (dgvwZasd B) Xodim filiali — egalik reestri doirasi uchun.
    @Optional()
    @Inject('BRANCH')
    private readonly branchClient?: ClientProxy,
  ) {}

  /**
   * (dgvwZasd A) Rol → papka oq ro'yxati va limit — `file-upload-policy.ts`.
   * `RolesGuard` multer'dan OLDIN ishlaydi: ruxsatsiz rol (mijoz, investor…)
   * faylni xotiraga yuklatmay 403 oladi. Papka multipart maydoni bo'lgani
   * uchun papka/rol mosligi handler'da tekshiriladi.
   */
  @Post('files/upload')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...UPLOAD_ROLES)
  @ApiOperation({
    summary: 'Upload file to MinIO (multipart/form-data)',
    description: uploadPolicySwaggerDescription(),
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        folder: {
          type: 'string',
          enum: UPLOAD_FOLDERS,
          default: DEFAULT_UPLOAD_FOLDER,
          example: 'proof',
        },
      },
      required: ['file'],
    },
  })
  @ApiCreatedResponse({ description: 'Fayl yuklandi' })
  @ApiForbiddenResponse({
    description: "Rolga ruxsat yo'q yoki papka oq ro'yxatda emas",
  })
  @ApiPayloadTooLargeResponse({
    description: 'Fayl limitdan katta (rasm/PDF/XLSX 10 MB, video 20 MB)',
  })
  @UseInterceptors(
    // Xotira chegarasi — siyosatdagi eng katta limit (video 20 MB; ilgari
    // 50 MB). Tur bo'yicha aniq limit handler'da, file-service ham o'zinikini
    // tekshiradi.
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: UPLOAD_MULTER_MAX_BYTES },
    }),
  )
  async uploadFile(
    @UploadedFile()
    file:
      | {
          originalname: string;
          mimetype: string;
          buffer: Buffer;
        }
      | undefined,
    @Req()
    req: {
      body?: Record<string, unknown>;
      user?: { sub?: string; roles?: string[]; branch_id?: string | null };
    },
  ) {
    if (!file) {
      throw new BadRequestException('Fayl majburiy');
    }

    const folder = canonicalUploadFolder(req?.body?.folder);
    assertFolderAllowed(folder, this.rolesOf(req));

    if (!this.allowedMime.has(file.mimetype)) {
      throw new BadRequestException("Bu fayl turi qo'llab-quvvatlanmaydi");
    }
    assertUploadFits(folder, file.mimetype, file.buffer.length);
    // E'lon qilingan tur faylning haqiqiy imzosiga mos kelishi shart —
    // `mimetype` ni mijoz yozadi, unga yolg'iz ishonib bo'lmaydi (audit S8).
    if (!matchesDeclaredType(file.buffer, file.mimetype)) {
      throw new BadRequestException(
        "Fayl mazmuni e'lon qilingan turga mos kelmadi",
      );
    }

    return firstValueFrom(
      this.fileClient
        .send(
          { cmd: 'file.upload' },
          {
            file_name: file.originalname,
            mime_type: file.mimetype,
            file_base64: file.buffer.toString('base64'),
            // Kanonik (tozalangan, kichik harf) papka — kalit prefiksi
            // maxfiy/ommaviy qoidalarga aynan mos tushadi.
            folder,
            owner: fileOwnerOf(req?.user),
          },
        )
        .pipe(timeout(FILE_RPC_TIMEOUT_MS)),
    );
  }

  // Sensitive object-key prefixes: COD-evidence, expense/return proof, receipts.
  // A signed URL for one of these is a bearer capability over *financial
  // evidence*, so minting it requires a staff/business role — not merely any
  // logged-in account. This narrows the previous "any authenticated user → any
  // file" object-level IDOR on GET/DELETE (Audit P1). The lowest-trust read-only
  // roles (customer, investor) are denied outright. Per-object ownership
  // (dgvwZasd B): `assertRegisteredFileAccess` below, for keys in the registry.
  //
  // 'ai-' (HD5zOyBp #6) — AI buyurtma rasmlari. Hozir ular UMUMAN saqlanmaydi
  // (ai-parse rasmni faqat RAM'da base64 qilib ai-service'ga uzatadi, MinIO'ga
  // yozmaydi) — bu prefiks chuqur himoya: kelajakda shunday kalit paydo
  // bo'lsa ham mijoz/investor unga imzolangan URL ololmaydi.
  private static readonly PRIVATE_KEY_PREFIXES = [
    'proof-',
    'expense-',
    'return-',
    'cod-',
    'receipt-',
    'ai-',
  ];

  private static readonly PRIVATE_FILE_ROLES = new Set<string>([
    RoleEnum.SUPERADMIN,
    RoleEnum.ADMIN,
    RoleEnum.MANAGER,
    RoleEnum.REGISTRATOR,
    RoleEnum.OPERATOR,
    RoleEnum.MARKET_OPERATOR,
    RoleEnum.BRANCH,
    RoleEnum.MARKET,
    RoleEnum.COURIER,
  ]);

  private rolesOf(req: { user?: { roles?: string[] } }): string[] {
    return (req?.user?.roles ?? []).map((role) =>
      String(role ?? '')
        .trim()
        .toLowerCase(),
    );
  }

  /** Faylni faqat o'z buyurtmasi doirasida ko'ra oladigan rollar. */
  private static readonly SCOPED_FILE_ROLES = new Set<string>([
    RoleEnum.MARKET,
    RoleEnum.MARKET_OPERATOR,
    RoleEnum.COURIER,
  ]);

  private async assertCanAccessPrivateKey(
    key: string,
    req: PrivateFileRequest,
  ): Promise<void> {
    const roles = this.rolesOf(req);
    const safeKey = String(key ?? '');
    // (kiZgTybn) Smena karta qoldig'i rasmi / smena hisoboti fayli — kassa
    // doirasiga bog'liq (menejer — faqat o'z filiali, registrator — asosiy
    // kassa). Umumiy kalit yo'li doirani bilmaydi, shuning uchun bu yerda
    // faqat superadmin/admin; qolganlar smena endpoint'lari bergan imzolangan
    // havola (`files/signed/:token`) orqali ochadi.
    if (isFileLinkKey(safeKey)) {
      if (
        !roles.some(
          (role) => role === RoleEnum.SUPERADMIN || role === RoleEnum.ADMIN,
        )
      ) {
        throw new ForbiddenException(
          'Smena fayli faqat smena hisoboti havolasi orqali ochiladi',
        );
      }
      return;
    }
    const isPrivate = FileGatewayController.PRIVATE_KEY_PREFIXES.some(
      (prefix) => safeKey.startsWith(prefix),
    );
    if (!isPrivate) {
      return;
    }
    const allowed = roles.some((role) =>
      FileGatewayController.PRIVATE_FILE_ROLES.has(role),
    );
    if (!allowed) {
      throw new ForbiddenException(
        'Bu maxfiy faylga (moliyaviy dalil) kirish uchun ruxsatingiz yetarli emas',
      );
    }

    const isScoped = roles.some((role) =>
      FileGatewayController.SCOPED_FILE_ROLES.has(role),
    );

    // (dgvwZasd B) Reestrda bor fayl — egalik qoidasi; reestrda YO'Q (eski)
    // fayl — pastdagi eski qoida o'zgarishsiz. Admin reestrga qaramaydi.
    const isAdmin = roles.some(
      (role) => role === RoleEnum.SUPERADMIN || role === RoleEnum.ADMIN,
    );
    if (!isAdmin && fileOwnershipEnforced()) {
      const record = await this.findFileOwner(safeKey);
      if (record) {
        await this.assertRegisteredFileAccess(record, req, isScoped);
        return;
      }
    }

    /**
     * ⚠️ PER-OBYEKT EGALIK TEKSHIRUVI (audit S5).
     *
     * Rol tekshiruvining o'zi "market rolidagi HAR KIM — HAR QANDAY
     * marketning dalilini" ochishga yo'l qo'yardi (kuryerlar uchun ham
     * xuddi shunday). Fayl kaliti o'zi bir bearer imkoniyat bo'lgani uchun
     * bu haqiqiy IDOR edi.
     *
     * Egalik munosabati allaqachon bazada: dalil fayllari buyurtmaning
     * `proof_files` ro'yxatida turadi. Shu bois yangi jadval kerak emas —
     * kalit bo'yicha buyurtma topiladi va so'rovchi o'sha buyurtmaga
     * tegishlimi degan savolga javob beriladi. Xodim rollari (admin,
     * manager, operator, registrator) avvalgidek ishlaydi: ular allaqachon
     * butun oqimni ko'radi.
     */
    if (!isScoped) {
      return;
    }

    const order = await this.findProofOrder(safeKey);
    if (!isOrderParticipant(order, String(req?.user?.sub ?? ''))) {
      throw new ForbiddenException(
        'Bu fayl sizning buyurtmangizga tegishli emas',
      );
    }
  }

  /** Dalil biriktirilgan buyurtma; topilmasa yoki xato bo'lsa — null. */
  private async findProofOrder(key: string): Promise<ProofOrderOwner | null> {
    const response = await firstValueFrom(
      this.orderClient
        .send<{
          data?: ProofOrderOwner | null;
        }>({ cmd: 'order.find_owner_by_proof_file' }, { key })
        .pipe(timeout(FILE_RPC_TIMEOUT_MS)),
    ).catch(() => null);
    return response?.data ?? null;
  }

  /**
   * (dgvwZasd B) Reestr qatori; qator yo'q — null. Tekshirib bo'lmasa 503:
   * "reestrda yo'q" deb eski (kengroq) qoidaga tushib ketmasin.
   */
  private async findFileOwner(key: string): Promise<FileOwnerRecord | null> {
    const response = await firstValueFrom(
      this.fileClient
        .send<{
          data?: FileOwnerRecord | null;
        }>({ cmd: 'file.find_owner' }, { key })
        .pipe(timeout(FILE_RPC_TIMEOUT_MS)),
    ).catch(() => {
      throw new ServiceUnavailableException(
        "Fayl egaligini tekshirib bo'lmadi — keyinroq urinib ko'ring",
      );
    });
    return response?.data ?? null;
  }

  /**
   * (dgvwZasd B) Reestrdagi shaxsiy faylni kim o'qiydi:
   *  - yuklagan foydalanuvchining o'zi (buyurtmaga biriktirilmasdan oldin ham);
   *  - market / kuryer — fayl biriktirilgan buyurtmaning ishtirokchisi
   *    (audit S5 qoidasi);
   *  - filial xodimi (menejer, registrator, filial, operator) — buyurtma
   *    uning filiali doirasida (`GET /orders/:id` bilan bir xil uch ustun)
   *    yoki yuklovchi uning filialidan; HQ xodimi — hammasi (HQ qo'lidagi
   *    bekor qilingan mollar, asosiy kassa dalillari).
   * Superadmin/admin bu yerga kelmaydi. Filial aniqlanmasa — rad.
   */
  private async assertRegisteredFileAccess(
    record: FileOwnerRecord,
    req: PrivateFileRequest,
    isScoped: boolean,
  ): Promise<void> {
    const sub = String(req?.user?.sub ?? '');
    if (sub && record.owner_id === sub) {
      return;
    }

    const order = await this.findProofOrder(record.key);
    if (isScoped) {
      if (isOrderParticipant(order, sub)) {
        return;
      }
      throw new ForbiddenException(
        'Bu fayl sizning buyurtmangizga tegishli emas',
      );
    }

    const branchId =
      String(req?.user?.branch_id ?? '').trim() ||
      (await this.findUserBranchId(sub));
    if (branchId) {
      if (isOrderInBranch(order, branchId)) {
        return;
      }
      const ownerBranchId =
        record.owner_branch_id ||
        (await this.findUserBranchId(record.owner_id));
      if (
        ownerBranchId === branchId ||
        (await this.findHqBranchId()) === branchId
      ) {
        return;
      }
    }
    throw new ForbiddenException('Bu fayl boshqa filialga tegishli');
  }

  /** Foydalanuvchi filiali (`branch.user.find_by_user`); xato — bo'sh. */
  private async findUserBranchId(userId: string | null): Promise<string> {
    if (!userId || !this.branchClient) {
      return '';
    }
    const response = await firstValueFrom(
      this.branchClient
        .send<{
          data?: { branch_id?: string | number | null } | null;
        }>(
          { cmd: 'branch.user.find_by_user' },
          { user_id: userId, requester: { id: userId, roles: [] } },
        )
        .pipe(timeout(FILE_RPC_TIMEOUT_MS)),
    ).catch(() => null);
    return String(response?.data?.branch_id ?? '').trim();
  }

  /** HQ filiali id si; xato — bo'sh (fail-closed). */
  private async findHqBranchId(): Promise<string> {
    if (!this.branchClient) {
      return '';
    }
    const response = await firstValueFrom(
      this.branchClient
        .send<{
          data?: { id?: string | number | null } | null;
        }>({ cmd: 'branch.find_hq' }, {})
        .pipe(timeout(FILE_RPC_TIMEOUT_MS)),
    ).catch(() => null);
    return String(response?.data?.id ?? '').trim();
  }

  @Get('files/:key')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get signed URL for file key' })
  @ApiParam({ name: 'key', description: 'Object key in MinIO' })
  @ApiOkResponse({ description: 'Imzolangan URL' })
  @ApiForbiddenResponse({ description: PRIVATE_FILE_FORBIDDEN_DESCRIPTION })
  @ApiQuery({
    name: 'expires_in',
    required: false,
    type: Number,
    example: 3600,
  })
  async getFileUrl(
    @Param('key') key: string,
    @Req() req: PrivateFileRequest,
    @Query('expires_in', new ParseIntPipe({ optional: true }))
    expires_in?: number,
  ) {
    await this.assertCanAccessPrivateKey(key, req);
    return firstValueFrom(
      this.fileClient
        .send({ cmd: 'file.get_url' }, { key, expires_in })
        .pipe(timeout(FILE_RPC_TIMEOUT_MS)),
    );
  }

  // Object-key prefixes that may be served UNAUTHENTICATED (so plain <img src>
  // works): public catalog images and operational batch photos only. Everything
  // else — expense-proof / COD-evidence / ad-hoc uploads — is private and must
  // go through the authenticated signed-URL route (GET files/:key). (Audit P1-7.)
  private static readonly PUBLIC_VIEW_PREFIXES = [
    'products-',
    'branch-transfer-batches-',
  ];

  @Public()
  @Get('files/view/:key')
  @ApiOperation({
    summary: 'Public view for whitelisted (catalog/batch) images',
  })
  @ApiParam({ name: 'key', description: 'Object key in MinIO' })
  async viewFile(@Param('key') key: string, @Res() res: Response) {
    const safeKey = String(key ?? '');
    const isPublic = FileGatewayController.PUBLIC_VIEW_PREFIXES.some((prefix) =>
      safeKey.startsWith(prefix),
    );
    if (!isPublic) {
      throw new ForbiddenException(
        'Bu fayl ochiq ko‘rishga ruxsat etilmagan; autentifikatsiyalangan imzolangan URL ishlating',
      );
    }
    const response = await firstValueFrom(
      this.fileClient
        .send<{
          data?: { body_base64?: string; mime_type?: string };
        }>({ cmd: 'file.read' }, { key })
        .pipe(timeout(FILE_RPC_TIMEOUT_MS)),
    );

    const bodyBase64 = response?.data?.body_base64;
    const mimeType = response?.data?.mime_type ?? 'application/octet-stream';
    if (!bodyBase64 || typeof bodyBase64 !== 'string') {
      throw new BadRequestException("Faylni o'qib bo'lmadi");
    }

    const buffer = Buffer.from(bodyBase64, 'base64');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(buffer);
  }

  /**
   * (YEVhU6XK) Fayl BAYTLARI — JWT bilan, gateway orqali.
   *
   * `GET files/:key` imzolangan URL qaytaradi, lekin u MinIO'ning ICHKI
   * manzilini (`http://minio:9000/...`) imzolaydi — MinIO tashqariga
   * chiqarilmagan, shuning uchun prod'da brauzer dalil rasm/videosini ocha
   * olmaydi (`ERR_BLOCKED_BY_ORB`). Frontend (`entities/order/api/proofFiles.ts`)
   * baytlarni shu yerdan oladi va `blob:` URL bilan ko'rsatadi.
   *
   * Ruxsat `GET files/:key` bilan AYNAN bir xil (`assertCanAccessPrivateKey`):
   * maxfiy kalitlar (`proof-`, `expense-`, …) — xodim rollari yoki faqat O'Z
   * buyurtmasining dalili (market/kuryer); smena fayllari (`shift-check-`,
   * `shift-report-`) — faqat superadmin/admin (qolganlar `files/signed/:token`);
   * boshqa kalitlar — kirgan foydalanuvchi.
   * Fayl topilmasa file-service'ning 404 xatosi qaytadi.
   */
  @Get('files/:key/content')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Read file bytes through the gateway (JWT)' })
  @ApiParam({ name: 'key', description: 'Object key in MinIO' })
  @ApiOkResponse({ description: 'Fayl baytlari' })
  @ApiForbiddenResponse({ description: PRIVATE_FILE_FORBIDDEN_DESCRIPTION })
  async getFileContent(
    @Param('key') key: string,
    @Req() req: PrivateFileRequest,
    @Res() res: Response,
  ) {
    await this.assertCanAccessPrivateKey(key, req);
    return this.sendPrivateFileBytes(key, res);
  }

  /**
   * (kiZgTybn) Smena karta qoldig'i rasmi / smena hisoboti fayli — brauzer
   * oddiy havola (`<a href target="_blank">`) bilan ochadi, Bearer sarlavhasi
   * yo'q. Ruxsat havolaning o'zida: gateway shifrlagan va autentifikatsiya
   * qilgan token (fayl kaliti + muddat ≤ 300 s) — `file-link.ts`. Tokenni
   * faqat kassa doirasi tekshirilgan smena endpoint'lari yaratadi
   * (`POST /finance/shift/account-photo`, `GET /finance/shift/:id/report`).
   * Baytlar `files/:key/content` bilan AYNAN bir xil yo'l (`file.read`) va
   * sarlavhalar bilan beriladi. Token soxta / o'zgartirilgan / muddati
   * o'tgan → 403 (fayl o'qilmaydi).
   */
  @Public()
  @Get('files/signed/:token')
  @ApiOperation({
    summary: '(kiZgTybn) Open a short-lived gateway-signed shift file link',
    description:
      "Smena karta qoldig'i rasmi yoki smena hisoboti fayli. Havola smena endpoint'laridan `photo_url` / `file_url` sifatida tayyor keladi (300 s) — frontend uni o'zi yasamaydi. JWT shart emas (oddiy `<a href>`); token yaroqsiz yoki muddati o'tgan → 403.",
  })
  @ApiParam({ name: 'token', description: 'Opaque short-lived link token' })
  @ApiForbiddenResponse({ description: "Havola yaroqsiz yoki muddati o'tgan" })
  async getSignedFileContent(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    const key = readFileLinkToken(token);
    if (!key) {
      throw new ForbiddenException(
        "Havola yaroqsiz yoki muddati o'tgan — sahifani yangilab qayta oching",
      );
    }
    return this.sendPrivateFileBytes(key, res, { download: true });
  }

  /**
   * Maxfiy fayl baytlari (`file.read`) — umumiy kesh va bajarilishsiz.
   * `download` — rasm bo'lmagan fayl (hisobot PDF/XLSX) yangi oynada
   * sandbox ichida emas, yuklab olish sifatida ochiladi.
   */
  private async sendPrivateFileBytes(
    key: string,
    res: Response,
    options: { download?: boolean } = {},
  ) {
    const response = await firstValueFrom(
      this.fileClient
        .send<{
          data?: { body_base64?: string; mime_type?: string };
        }>({ cmd: 'file.read' }, { key })
        .pipe(timeout(FILE_RPC_TIMEOUT_MS)),
    );

    const bodyBase64 = response?.data?.body_base64;
    if (!bodyBase64 || typeof bodyBase64 !== 'string') {
      throw new BadRequestException("Faylni o'qib bo'lmadi");
    }

    const buffer = Buffer.from(bodyBase64, 'base64');
    const mimeType = response?.data?.mime_type ?? 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Length', String(buffer.length));
    // Maxfiy dalil — umumiy (CDN/proksi) keshga tushmasin.
    res.setHeader('Cache-Control', 'private, max-age=300');
    // Yuklangan fayl hech qachon sahifa sifatida bajarilmasin.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (options.download) {
      const fileName = String(key).replace(/[^\w.-]/g, '_');
      res.setHeader(
        'Content-Disposition',
        mimeType.startsWith('image/')
          ? 'inline'
          : `attachment; filename="${fileName}"`,
      );
      res.setHeader('Referrer-Policy', 'no-referrer');
    }
    return res.send(buffer);
  }

  // Deleting a stored object is a destructive, irreversible operation over
  // shared storage (product images, COD-evidence, expense proof). It is an
  // administrative action, so it is restricted to SUPERADMIN/ADMIN rather than
  // any authenticated user (Audit P1: previously any logged-in account could
  // delete ANY file by key).
  @Delete('files/:key')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN)
  @ApiOperation({ summary: 'Delete file by key (admin only)' })
  @ApiParam({ name: 'key', description: 'Object key in MinIO' })
  deleteFile(@Param('key') key: string) {
    return this.fileClient
      .send({ cmd: 'file.delete' }, { key })
      .pipe(timeout(FILE_RPC_TIMEOUT_MS));
  }

  /**
   * (dgvwZasd A) Ilgari rolsiz edi — istalgan kirgan foydalanuvchi (mijoz
   * ham) MinIO'ga ixtiyoriy papkaga fayl yozdira olardi. Jonli frontend bu
   * endpoint'ni chaqirmaydi (yorliq QR'i brauzerda chiziladi); branch-service
   * QR'ni to'g'ridan-to'g'ri RPC bilan yaratadi. Endi — faqat xodimlar.
   */
  @Post('files/qr')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiOperation({ summary: 'Generate QR and upload to MinIO' })
  @ApiBody({ type: GenerateQrRequestDto })
  generateQr(@Body() dto: GenerateQrRequestDto) {
    return this.fileClient
      .send({ cmd: 'file.generate_qr' }, dto)
      .pipe(timeout(FILE_RPC_TIMEOUT_MS));
  }

  /** (dgvwZasd A) `files/qr` bilan bir xil — faqat xodimlar. */
  @Post('files/pdf')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(RoleEnum.SUPERADMIN, RoleEnum.ADMIN, RoleEnum.MANAGER)
  @ApiOperation({ summary: 'Generate PDF and upload to MinIO' })
  @ApiBody({ type: GeneratePdfRequestDto })
  generatePdf(@Body() dto: GeneratePdfRequestDto) {
    return this.fileClient
      .send({ cmd: 'file.generate_pdf' }, dto)
      .pipe(timeout(FILE_RPC_TIMEOUT_MS));
  }
}
