import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { rmqSend } from '@app/common';
import { audienceRpcError } from '../audience/audience-request';

/** identity `contacts_by_ids` bitta so'rovda 5000 tagacha; biz 1000 dan. */
const LOOKUP_CHUNK = 1000;

/**
 * (3SeRYFqx #3) Aniq `recipient_id(s)` — identity'da MAVJUD va o'chirilmagan
 * foydalanuvchimi? Avval tekshirilmasdi: hech kim hech qachon o'qiy
 * olmaydigan "yetim" inbox qatori yozilardi (`inbox.delete` ham
 * `requireOwned` talab qiladi — uni hech kim o'chira olmasdi).
 *
 * Nega `identity.user.contacts_by_ids` (kartadagi `user.find_all` EMAS):
 * `find_all` superadmin va mijozni ATAYLAB chiqarib tashlaydi (GET /users
 * xavfsizligi) — u bilan haqiqiy superadmin/mijoz qabul qiluvchi "topilmadi"
 * bo'lib qolardi. `contacts_by_ids` — rol filtrsiz, faqat `isDeleted=false`,
 * notification-service uni allaqachon (SMS/push/til) ishlatadi. Javobdagi
 * telefon bu yerda ISHLATILMAYDI va logga tushmaydi — faqat `id`.
 *
 * ⚠️ FAIL-CLOSED: identity javob bermasa — xato (502), "hammasi topilmadi"
 * deb 400 EMAS va tekshiruvsiz yozish ham EMAS.
 */
@Injectable()
export class RecipientDirectoryService {
  constructor(
    @Inject('IDENTITY') private readonly identityClient: ClientProxy,
  ) {}

  /** Berilgan id'lardan mavjud (o'chirilmagan) foydalanuvchilar to'plami. */
  async existing(ids: readonly string[]): Promise<Set<string>> {
    const unique = [...new Set(ids.map((id) => String(id).trim()))].filter(
      Boolean,
    );
    const found = new Set<string>();
    for (let start = 0; start < unique.length; start += LOOKUP_CHUNK) {
      const chunk = unique.slice(start, start + LOOKUP_CHUNK);
      let res: unknown;
      try {
        res = await rmqSend<unknown>(
          this.identityClient,
          { cmd: 'identity.user.contacts_by_ids' },
          { ids: chunk },
        );
      } catch (error) {
        throw audienceRpcError(error);
      }
      const list = Array.isArray(res)
        ? (res as Array<{ id?: unknown }>)
        : ((res as { data?: Array<{ id?: unknown }> } | null)?.data ?? []);
      for (const user of list) {
        const id =
          typeof user?.id === 'string' || typeof user?.id === 'number'
            ? String(user.id)
            : '';
        if (id) found.add(id);
      }
    }
    return found;
  }
}
