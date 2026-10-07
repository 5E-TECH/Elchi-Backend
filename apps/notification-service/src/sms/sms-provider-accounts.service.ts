import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SmsProviderAccount } from '../entities/sms-provider-account.entity';
import { SmsCredentialCipher } from './sms-credential.cipher';
import { SMS_SENDER_PROFILES, SmsSenderProfile } from './sms.port';

export const SMS_PROVIDERS = ['eskiz', 'playmobile'] as const;
export type SmsProviderName = (typeof SMS_PROVIDERS)[number];

export interface ProviderCredentials {
  provider: string;
  senderProfile: SmsSenderProfile;
  login: string;
  password: string;
  sender: string;
}

export interface UpsertAccountInput {
  provider: string;
  sender_profile: string;
  login: string;
  password: string;
  sender: string;
  is_active?: boolean;
}

const mask = (value: string) =>
  value.length <= 4 ? '****' : `${value.slice(0, 2)}****${value.slice(-2)}`;

/**
 * Provayder akkauntlari — kredensial FAQAT shifrlangan holda DB'da (8auPBa1O #2).
 * Kodda/.env da login, parol yoki alfa-nom yo'q.
 */
@Injectable()
export class SmsProviderAccountsService {
  private readonly cipher: SmsCredentialCipher;
  /** Yangilanganda registry adapter keshini tozalaydi. */
  private readonly listeners = new Set<() => void>();

  constructor(
    @InjectRepository(SmsProviderAccount)
    private readonly repo: Repository<SmsProviderAccount>,
    config: ConfigService,
  ) {
    this.cipher = new SmsCredentialCipher(
      config.get<string>('SMS_CREDENTIAL_SECRET'),
      config.get<string>('SMS_CREDENTIAL_SECRET_PREVIOUS'),
    );
  }

  onChange(listener: () => void) {
    this.listeners.add(listener);
  }

  get cipherConfigured(): boolean {
    return this.cipher.configured;
  }

  async getCredentials(
    provider: string,
    senderProfile: SmsSenderProfile,
  ): Promise<ProviderCredentials | null> {
    if (!this.cipher.configured) return null;
    const row = await this.repo.findOne({
      where: { provider, sender_profile: senderProfile, is_active: true },
    });
    if (!row) return null;
    return {
      provider,
      senderProfile,
      login: this.cipher.decrypt(row.login_enc),
      password: this.cipher.decrypt(row.password_enc),
      sender: row.sender,
    };
  }

  async upsert(input: UpsertAccountInput, userId: string | null) {
    const provider = String(input.provider ?? '')
      .trim()
      .toLowerCase();
    if (!SMS_PROVIDERS.includes(provider as SmsProviderName)) {
      throw new Error(
        `provider quyidagilardan biri: ${SMS_PROVIDERS.join(', ')}`,
      );
    }
    if (
      !SMS_SENDER_PROFILES.includes(input.sender_profile as SmsSenderProfile)
    ) {
      throw new Error(
        `sender_profile quyidagilardan biri: ${SMS_SENDER_PROFILES.join(', ')}`,
      );
    }
    const login = String(input.login ?? '').trim();
    const password = String(input.password ?? '');
    const sender = String(input.sender ?? '').trim();
    if (!login || !password || !sender)
      throw new Error('login, password va sender majburiy');

    const existing = await this.repo.findOne({
      where: {
        provider,
        sender_profile: input.sender_profile as SmsSenderProfile,
      },
    });
    const row = this.repo.create({
      ...(existing ?? {}),
      provider,
      sender_profile: input.sender_profile as SmsSenderProfile,
      login_enc: this.cipher.encrypt(login),
      password_enc: this.cipher.encrypt(password),
      sender,
      is_active: input.is_active ?? true,
      updated_by: userId,
    });
    const saved = await this.repo.save(row);
    this.listeners.forEach((listener) => listener());
    return this.toPublic(saved, login);
  }

  /** Admin ko'rinishi — parol HECH QACHON qaytmaydi, login maskalangan. */
  async list() {
    const rows = await this.repo.find({
      order: { provider: 'ASC', sender_profile: 'ASC' },
    });
    return rows.map((row) => {
      let login = '****';
      try {
        login = this.cipher.configured
          ? this.cipher.decrypt(row.login_enc)
          : '****';
      } catch {
        login = '****';
      }
      return this.toPublic(row, login);
    });
  }

  private toPublic(row: SmsProviderAccount, login: string) {
    return {
      id: row.id,
      provider: row.provider,
      sender_profile: row.sender_profile,
      login: mask(login),
      sender: row.sender,
      is_active: row.is_active,
      updated_at: row.updated_at,
    };
  }
}
