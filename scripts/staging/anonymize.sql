-- ============================================================================
-- STAGING anonimizatsiyasi — prod nusxasidan haqiqiy odamlarga tegishli hamma
-- narsani olib tashlaydi. FAQAT `scripts/staging/restore-anonymize.sh` orqali
-- (u `psql --single-transaction -v ON_ERROR_STOP=1` bilan chaqiradi, oxirida
-- verify.sql ham SHU tranzaksiyada — tekshiruv yiqilsa hammasi ROLLBACK va
-- skript tiklangan bazani o'chirib tashlaydi).
--
-- Kutiladigan psql o'zgaruvchilari (skript beradi, qo'lda bermang):
--   stg_pw_hash    — STAGING_DEFAULT_PASSWORD dan ISHGA TUSHIRISH paytida
--                    (bcryptjs, 12) olingan xesh; parolning o'zi bazaga, faylga
--                    yoki argv'ga HECH QACHON tushmaydi (faqat xesh).
--   keep_user_ids  — vergulli ro'yxat (sukut: 1,25,26,37,53) — hisobotda
--                    login telefonini chop etish uchun; ular ham maskalanadi.
--
-- Yozilish uslubi: har jadval/ustun `pg_temp` yordamchilari orqali — mavjud
-- bo'lmasa jim o'tkaziladi (IF EXISTS), NOT NULL ustunga NULL yozilmaydi
-- (DEFAULT yoki bo'sh qiymat). Ombor (catalog_schema stock_*) jadvallariga
-- TEGILMAYDI (append-only trigger + ombor egasi qoidasi).
--
-- Maska formati (verify.sql shu bilan tekshiradi):
--   telefon   → +99877NNNNNNN (N = qator id, 7 xona; libphonenumber 'UZ' uchun
--               yaroqli, IsPhoneNumber('UZ') DTO'lar staging'da ishlaydi);
--   matndagi telefon → +998770000000 / 998770000000 / 770000000.
-- ============================================================================

\set ON_ERROR_STOP on
-- Yordamchi SELECT'larning bo'sh natijalari chop etilmasin (hisobot oxirida).
\o /dev/null
SET LOCAL statement_timeout = 0;
SET LOCAL lock_timeout = '60s';
SET LOCAL client_min_messages = notice;

-- ---------------------------------------------------------------------------
-- 0. Yordamchilar (pg_temp — sessiya tugashi bilan yo'qoladi)
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.app_schemas() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['identity_schema','order_schema','catalog_schema','logistics_schema',
               'finance_schema','notification_schema','integration_schema',
               'branch_schema','investor_schema','c2c_schema','search_schema',
               'ai_schema']
$$;

CREATE FUNCTION pg_temp.tbl(s text, t text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_schema = s AND table_name = t
                    AND table_type = 'BASE TABLE')
$$;

CREATE FUNCTION pg_temp.col(s text, t text, c text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = s AND table_name = t AND column_name = c)
$$;

-- Bajarilgan amallar jurnali (oxirida hisobot sifatida chop etiladi).
CREATE TEMP TABLE stg_log (
  seq serial, target text, action text, affected bigint
) ON COMMIT DROP;

CREATE FUNCTION pg_temp.run(target text, action text, q text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  EXECUTE q;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO stg_log (target, action, affected) VALUES (target, action, n);
END $$;

-- Jadval bo'lsa — barcha qatorlarni o'chiradi.
CREATE FUNCTION pg_temp.wipe(s text, t text, cond text DEFAULT 'true') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_temp.tbl(s, t) THEN
    PERFORM pg_temp.run(s || '.' || t, 'DELETE WHERE ' || cond,
      format('DELETE FROM %I.%I WHERE %s', s, t, cond));
  END IF;
END $$;

-- Ustun bo'lsa — `expr` bilan almashtiradi (faqat NULL bo'lmagan qatorlar).
CREATE FUNCTION pg_temp.setcol(s text, t text, c text, expr text,
                               cond text DEFAULT 'true') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_temp.col(s, t, c) THEN
    PERFORM pg_temp.run(s || '.' || t || '.' || c, 'SET ' || expr,
      format('UPDATE %I.%I SET %I = %s WHERE %I IS NOT NULL AND (%s)',
             s, t, c, expr, c, cond));
  END IF;
END $$;

-- Ustunni "bo'shatadi": nullable → NULL; NOT NULL → DEFAULT (bo'lsa) yoki
-- turga mos bo'sh qiymat ('', '{}'::jsonb).
CREATE FUNCTION pg_temp.clear(s text, t text, c text, cond text DEFAULT 'true')
RETURNS void LANGUAGE plpgsql AS $$
DECLARE nullable text; dflt text; typ text; v text;
BEGIN
  SELECT is_nullable, column_default, data_type INTO nullable, dflt, typ
    FROM information_schema.columns
   WHERE table_schema = s AND table_name = t AND column_name = c;
  IF NOT FOUND THEN RETURN; END IF;
  IF nullable = 'YES' THEN v := 'NULL';
  ELSIF dflt IS NOT NULL THEN v := 'DEFAULT';
  ELSIF typ IN ('jsonb', 'json') THEN v := '''{}''';
  ELSIF typ IN ('text', 'character varying', 'character') THEN v := '''''';
  ELSE
    RAISE NOTICE 'clear(%.%.%): NOT NULL % ustun — o''tkazildi', s, t, c, typ;
    RETURN;
  END IF;
  PERFORM pg_temp.run(s || '.' || t || '.' || c, 'CLEAR → ' || v,
    format('UPDATE %I.%I SET %I = %s WHERE %I IS NOT NULL AND (%s)',
           s, t, c, v, c, cond));
END $$;

-- Telefon maskasi: +99877 + id (7 xona). Ustun 13 belgidan qisqa bo'lsa '+' siz.
CREATE FUNCTION pg_temp.mask_phone(k bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT '+99877' || lpad((abs(k) % 10000000)::text, 7, '0')
$$;

-- Matn ichidagi telefonlar. `bare` = true bo'lsa formatlanmagan 9 xonali
-- mobil raqamlar ham (faqat erkin matn ustunlari — JSON pul summalariga emas).
CREATE FUNCTION pg_temp.scrub(v text, bare boolean DEFAULT true) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL THEN NULL ELSE
    CASE WHEN bare THEN regexp_replace(
      regexp_replace(
        regexp_replace(v,
          '\+998[\s\-]?\(?\d{2}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}', '+998770000000', 'g'),
        '(?<!\d)998\d{9}(?!\d)', '998770000000', 'g'),
      '(?<![0-9+])\(?(?:9[0-9]|33|50|55|77|88|20|6[1-9]|7[0-9])\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}(?!\d)',
      '770000000', 'g')
    ELSE
      regexp_replace(
        regexp_replace(v,
          '\+998[\s\-]?\(?\d{2}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}', '+998770000000', 'g'),
        '(?<!\d)998\d{9}(?!\d)', '998770000000', 'g')
    END
  END
$$;

-- jsonb ichidagi telefonlar (faqat +998… va 998XXXXXXXXX — JSON yaroqliligi saqlanadi).
CREATE FUNCTION pg_temp.scrub_json(v jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL THEN NULL ELSE pg_temp.scrub(v::text, false)::jsonb END
$$;

-- Ustundagi telefonlarni tozalaydi (text/varchar yoki jsonb — turi avtomatik).
CREATE FUNCTION pg_temp.scrubcol(s text, t text, c text, bare boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE typ text;
BEGIN
  SELECT data_type INTO typ FROM information_schema.columns
   WHERE table_schema = s AND table_name = t AND column_name = c;
  IF NOT FOUND THEN RETURN; END IF;
  IF typ IN ('jsonb', 'json') THEN
    PERFORM pg_temp.run(s || '.' || t || '.' || c, 'SCRUB phones (json)',
      format('UPDATE %I.%I SET %I = pg_temp.scrub_json(%I::jsonb)::%s
               WHERE %I IS NOT NULL AND %I::text ~ ''998''',
             s, t, c, c, typ, c, c));
  ELSIF typ IN ('text', 'character varying', 'character') THEN
    PERFORM pg_temp.run(s || '.' || t || '.' || c, 'SCRUB phones',
      format('UPDATE %I.%I SET %I = pg_temp.scrub(%I, %L)
               WHERE %I IS NOT NULL AND %I ~ ''\d{3}''
                 AND %I IS DISTINCT FROM pg_temp.scrub(%I, %L)',
             s, t, c, c, bare, c, c, c, c, bare));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Staging parol xeshi (skript ishga tushganda bcryptjs bilan olingan)
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE stg_secret ON COMMIT DROP AS SELECT :'stg_pw_hash'::text AS pw_hash;
DO $$
BEGIN
  -- bcryptjs bilan mos: $2a$/$2b$ 12 (BCRYPT_ROUNDS — login'da qayta xeshlanmaydi).
  IF (SELECT pw_hash FROM stg_secret) !~ '^\$2[ab]\$12\$[./A-Za-z0-9]{53}$' THEN
    RAISE EXCEPTION 'stg_pw_hash bcrypt (12) xeshi emas';
  END IF;
END $$;

-- Aylantiriladigan sirlarning ESKI qiymatlari (verify: hech biri qolmagan).
CREATE TEMP TABLE stg_old_secrets (kind text, val text) ON COMMIT DROP;
DO $$
BEGIN
  IF pg_temp.col('identity_schema', 'admins', 'market_tg_token') THEN
    INSERT INTO stg_old_secrets
      SELECT 'market_tg_token', market_tg_token FROM identity_schema.admins
       WHERE market_tg_token IS NOT NULL;
  END IF;
  IF pg_temp.col('integration_schema', 'partners', 'api_key_hash') THEN
    INSERT INTO stg_old_secrets
      SELECT 'partner_api_key_hash', api_key_hash FROM integration_schema.partners
       WHERE api_key_hash IS NOT NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. identity_schema — foydalanuvchilar, sessiyalar, OTP
-- ---------------------------------------------------------------------------
DO $$
DECLARE s text := 'identity_schema'; t text := 'admins';
BEGIN
  IF NOT pg_temp.tbl(s, t) THEN RETURN; END IF;
  -- UNIQUE(phone_number): avval vaqtinchalik noyob qiymat, keyin maska
  -- (haqiqiy raqam boshqa qatorning maskasiga to'g'ri kelsa ham to'qnashmaydi).
  PERFORM pg_temp.setcol(s, t, 'phone_number', '''stg-'' || id');
  PERFORM pg_temp.setcol(s, t, 'phone_number', 'pg_temp.mask_phone(id)');
  PERFORM pg_temp.setcol(s, t, 'username', '''stg-'' || id');
  PERFORM pg_temp.setcol(s, t, 'username', '''user'' || id');
  PERFORM pg_temp.setcol(s, t, 'name', 'initcap(replace(role::text, ''_'', '' '')) || '' #'' || id');
  PERFORM pg_temp.setcol(s, t, 'extra_number', 'pg_temp.mask_phone(id)');
  PERFORM pg_temp.setcol(s, t, 'default_operator_phone', 'pg_temp.mask_phone(id)');
  PERFORM pg_temp.setcol(s, t, 'address', '''Staging manzil #'' || id');
  -- Parol: HAMMA akkaunt (TEST 1/25/26/37/53 ham) — bitta staging paroli.
  PERFORM pg_temp.setcol(s, t, 'password', '(SELECT pw_hash FROM stg_secret)');
  PERFORM pg_temp.setcol(s, t, 'must_change_password', 'false');
  PERFORM pg_temp.clear(s, t, 'refresh_token');
  -- Mavjud JWT'lar bekor (session_epoch oshadi).
  PERFORM pg_temp.setcol(s, t, 'session_epoch', 'session_epoch + 1');
  -- Telegram bog'lamalari.
  PERFORM pg_temp.clear(s, t, 'telegram_id');
  PERFORM pg_temp.clear(s, t, 'telegram_username');
  PERFORM pg_temp.clear(s, t, 'telegram_linked_at');
  -- Market API (Telegram guruh) tokeni — tasodifiy yangi qiymat.
  PERFORM pg_temp.setcol(s, t, 'market_tg_token',
    '''group_token-'' || replace(gen_random_uuid()::text, ''-'', '''')');
  PERFORM pg_temp.scrubcol(s, t, 'settings');
END $$;

SELECT pg_temp.wipe('identity_schema', 'user_sessions');
SELECT pg_temp.wipe('identity_schema', 'otp_codes');
SELECT pg_temp.wipe('identity_schema', 'auth_login_throttle');
-- Parallel branch'lar qo'shayotgan jadvallar (bo'lsa): vaqtinchalik parol SMS izi.
SELECT pg_temp.wipe('identity_schema', 'user_password_sms');

-- ---------------------------------------------------------------------------
-- 3. order_schema — mijoz manzili, izohlar, operator telefonlari
-- ---------------------------------------------------------------------------
SELECT pg_temp.setcol('order_schema', 'orders', 'address', '''Staging manzil, buyurtma #'' || id');
SELECT pg_temp.setcol('order_schema', 'orders', 'extra_number', 'pg_temp.mask_phone(id)');
SELECT pg_temp.setcol('order_schema', 'orders', 'operator_phone', 'pg_temp.mask_phone(id)');
SELECT pg_temp.setcol('order_schema', 'orders', 'secondary_operator_phone', 'pg_temp.mask_phone(id)');
SELECT pg_temp.setcol('order_schema', 'orders', 'operator', '''Operator #'' || id');
SELECT pg_temp.setcol('order_schema', 'orders', 'comment', '''[staging] izoh #'' || id');
SELECT pg_temp.scrubcol('order_schema', 'orders', 'return_reason');
SELECT pg_temp.scrubcol('order_schema', 'order_tracking', 'description');
SELECT pg_temp.scrubcol('order_schema', 'order_tracking', 'note');
-- Diff qiymatlari (manzil/ism o'zgarishlari) — holat ustunlari qoladi.
SELECT pg_temp.clear('order_schema', 'order_tracking', 'old_value');
SELECT pg_temp.clear('order_schema', 'order_tracking', 'new_value');
SELECT pg_temp.scrubcol('order_schema', 'order_tracking', 'metadata');
SELECT pg_temp.scrubcol('order_schema', 'order_custody_events', 'note');
SELECT pg_temp.scrubcol('order_schema', 'order_extra_cost_approvals', 'decision_comment');
SELECT pg_temp.scrubcol('order_schema', 'order_extra_cost_approvals', 'reject_reason');
SELECT pg_temp.setcol('order_schema', 'branch_transfer_batches', 'driver_name', '''Haydovchi #'' || id');
SELECT pg_temp.setcol('order_schema', 'branch_transfer_batches', 'driver_phone', 'pg_temp.mask_phone(id)');
SELECT pg_temp.setcol('order_schema', 'branch_transfer_batches', 'vehicle_plate', '''STG'' || id');
SELECT pg_temp.scrubcol('order_schema', 'branch_transfer_batch_history', 'notes');

-- ---------------------------------------------------------------------------
-- 4. c2c / investor / finance / branch / logistics — PII ustunlari
-- ---------------------------------------------------------------------------
SELECT pg_temp.setcol('c2c_schema', 'listings', 'description', '''[staging] tavsif #'' || id');
SELECT pg_temp.setcol('c2c_schema', 'listings', 'location', '''Staging joy #'' || id');
SELECT pg_temp.setcol('c2c_schema', 'reviews', 'comment', '''[staging] sharh #'' || id');
SELECT pg_temp.setcol('c2c_schema', 'disputes', 'reason', '''[staging] sabab #'' || id');
SELECT pg_temp.setcol('c2c_schema', 'disputes', 'resolution', '''[staging] yechim #'' || id');

SELECT pg_temp.setcol('investor_schema', 'investors', 'name', '''Investor #'' || id');
SELECT pg_temp.setcol('investor_schema', 'investors', 'phone_number', '''stg-'' || id');
SELECT pg_temp.setcol('investor_schema', 'investors', 'phone_number', 'pg_temp.mask_phone(id)');
SELECT pg_temp.scrubcol('investor_schema', 'investors', 'description');
SELECT pg_temp.scrubcol('investor_schema', 'investments', 'description');
SELECT pg_temp.scrubcol('investor_schema', 'profit_shares', 'description');

SELECT pg_temp.setcol('finance_schema', 'cashbox_cards', 'holder_name', '''Karta egasi #'' || id');
SELECT pg_temp.scrubcol('finance_schema', 'cashbox_cards', 'note');
SELECT pg_temp.clear('finance_schema', 'shift_account_checks', 'ai_raw');
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('cashbox_history', 'comment'), ('financial_balance_history', 'comment'),
      ('shifts', 'comment'), ('shift_account_checks', 'comment'),
      ('courier_payment_acks', 'comment'), ('operator_payments', 'note'),
      ('cashbox_card_movements', 'comment'), ('cashbox_expense_categories', 'description'))
      AS v(t, c)
  LOOP
    PERFORM pg_temp.scrubcol('finance_schema', r.t, r.c);
  END LOOP;
END $$;
SELECT pg_temp.scrubcol('integration_schema', 'provider_remittances', 'note');
SELECT pg_temp.scrubcol('integration_schema', 'provider_remittances', 'cancel_reason');
-- Filial telefoni (ko'pincha menejerning shaxsiy raqami) — umumiy telefon bosqichida.

-- ---------------------------------------------------------------------------
-- 5. notification_schema — Telegram, push, SMS, kampaniyalar, inbox
-- ---------------------------------------------------------------------------
-- Telegram: market guruhlari (group_id NOT NULL → qator o'chiriladi; trigger
-- telegram_chats'ni nofaol qiladi), shaxsiy/guruh chat bog'lamalari, sessiyalar,
-- navbat (outbox) — hammasi.
SELECT pg_temp.wipe('notification_schema', 'telegram_order_cards');
SELECT pg_temp.wipe('notification_schema', 'telegram_bot_actions');
SELECT pg_temp.wipe('notification_schema', 'telegram_ai_drafts');
SELECT pg_temp.wipe('notification_schema', 'telegram_sessions');
SELECT pg_temp.wipe('notification_schema', 'telegram_link_tokens');
SELECT pg_temp.wipe('notification_schema', 'telegram_rate_limits');
SELECT pg_temp.wipe('notification_schema', 'telegram_outbox');
SELECT pg_temp.wipe('notification_schema', 'telegram_markets');
SELECT pg_temp.wipe('notification_schema', 'telegram_chats');

-- Web push obunalari.
SELECT pg_temp.wipe('notification_schema', 'push_subscriptions');

-- SMS: kutayotganlar yuborilmaydi; tarix — telefon/matn maskalanadi.
SELECT pg_temp.wipe('notification_schema', 'sms_provider_accounts');
DO $$
BEGIN
  IF pg_temp.tbl('notification_schema', 'sms_outbox') THEN
    PERFORM pg_temp.run('notification_schema.sms_outbox', 'pending/processing → failed',
      $q$UPDATE notification_schema.sms_outbox
            SET status = 'failed', next_retry_at = NULL,
                last_error = 'staging_anonymize: navbat tozalandi (yuborilmaydi)'
          WHERE status IN ('pending', 'processing')$q$);
  END IF;
END $$;
SELECT pg_temp.setcol('notification_schema', 'sms_outbox', 'to_phone', 'pg_temp.mask_phone(id)');
SELECT pg_temp.setcol('notification_schema', 'sms_outbox', 'text', '''[staging] SMS matni #'' || id');
SELECT pg_temp.clear('notification_schema', 'sms_outbox', 'last_response');
SELECT pg_temp.setcol('notification_schema', 'customer_consent', 'phone', 'pg_temp.mask_phone(id)');
SELECT pg_temp.scrubcol('notification_schema', 'customer_consent', 'evidence');
-- Rejalashtirilgan / navbatdagi SMS kampaniyalar — bekor.
DO $$
BEGIN
  IF pg_temp.col('notification_schema', 'sms_campaigns', 'status') THEN
    PERFORM pg_temp.run('notification_schema.sms_campaigns', 'scheduled/queued/running → cancelled',
      format($q$UPDATE notification_schema.sms_campaigns
                  SET status = 'cancelled'%s
                WHERE status IN ('scheduled', 'queued', 'running')$q$,
             CASE WHEN pg_temp.col('notification_schema', 'sms_campaigns', 'cancelled_at')
                  THEN ', cancelled_at = now()' ELSE '' END));
  END IF;
  -- Bildirishnoma kampaniyalari: navbatdagi/rejalashtirilgan/yuborilayotgan —
  -- bekor (draft'lar o'zi yuborilmaydi — qoladi).
  IF pg_temp.col('notification_schema', 'notification_campaigns', 'status') THEN
    PERFORM pg_temp.run('notification_schema.notification_campaigns', 'queued/running → cancelled',
      $q$UPDATE notification_schema.notification_campaigns
            SET status = 'cancelled'
          WHERE status IN ('queued', 'running')$q$);
  END IF;
END $$;
SELECT pg_temp.scrubcol('notification_schema', 'sms_campaigns', 'text');
SELECT pg_temp.scrubcol('notification_schema', 'notification_campaigns', 'body');
SELECT pg_temp.wipe('notification_schema', 'campaign_report_exports');
-- Inbox va qo'lda yuborilgan xabarlar — matndagi telefonlar.
SELECT pg_temp.scrubcol('notification_schema', 'notifications', 'title');
SELECT pg_temp.scrubcol('notification_schema', 'notifications', 'body');
SELECT pg_temp.scrubcol('notification_schema', 'notifications', 'data');
SELECT pg_temp.scrubcol('notification_schema', 'notification_dispatches', 'body');
SELECT pg_temp.scrubcol('notification_schema', 'notification_dispatches', 'message');
-- Notification outbox — kutayotgan HAMMA hodisa (yetkazish = haqiqiy odamga xabar).
SELECT pg_temp.wipe('notification_schema', 'outbox_events');

-- ---------------------------------------------------------------------------
-- 6. integration_schema — DATA darajasida o'chirish (BeePost/hamkor KODIga
--    tegilmaydi): flaglar o'chiq, URL'lar .invalid, sirlar bo'sh, navbat tozalangan.
-- ---------------------------------------------------------------------------
DO $$
DECLARE s text := 'integration_schema'; t text := 'external_integrations'; c text;
BEGIN
  IF NOT pg_temp.tbl(s, t) THEN RETURN; END IF;
  FOREACH c IN ARRAY ARRAY['is_active', 'webhook_enabled', 'reconcile_enabled',
                           'enabled', 'use_auth'] LOOP
    PERFORM pg_temp.setcol(s, t, c, 'false');
  END LOOP;
  FOREACH c IN ARRAY ARRAY['base_url', 'api_url', 'auth_url', 'endpoint'] LOOP
    PERFORM pg_temp.setcol(s, t, c, '''https://staging-disabled.invalid''');
  END LOOP;
  FOREACH c IN ARRAY ARRAY['credentials', 'api_key', 'api_secret', 'username',
                           'password', 'webhook_secret', 'webhook_secret_previous',
                           'headers'] LOOP
    PERFORM pg_temp.clear(s, t, c);
  END LOOP;
END $$;

DO $$
DECLARE s text := 'integration_schema'; t text := 'partners'; c text;
BEGIN
  IF NOT pg_temp.tbl(s, t) THEN RETURN; END IF;
  PERFORM pg_temp.setcol(s, t, 'is_active', 'false');
  PERFORM pg_temp.setcol(s, t, 'sandbox_enabled', 'false');
  FOREACH c IN ARRAY ARRAY['webhook_url', 'sandbox_webhook_url', 'webhook_secret',
                           'webhook_secret_previous', 'sandbox_webhook_secret'] LOOP
    PERFORM pg_temp.clear(s, t, c);
  END LOOP;
  -- API kaliti xeshi — tasodifiy (hamkorning prod kaliti staging'da ishlamaydi).
  PERFORM pg_temp.setcol(s, t, 'api_key_hash',
    'replace(gen_random_uuid()::text, ''-'', '''') || replace(gen_random_uuid()::text, ''-'', '''')');
END $$;

SELECT pg_temp.wipe('integration_schema', 'partner_webhook_outbox');
DO $$
BEGIN
  IF pg_temp.col('integration_schema', 'sync_queue', 'status') THEN
    PERFORM pg_temp.run('integration_schema.sync_queue', 'pending/processing → failed',
      $q$UPDATE integration_schema.sync_queue
            SET status = 'failed', next_retry_at = NULL,
                last_error = 'staging_anonymize: navbat tozalandi'
          WHERE status IN ('pending', 'processing', 'retry')$q$);
  END IF;
END $$;
SELECT pg_temp.scrubcol('integration_schema', 'sync_queue', 'payload');
SELECT pg_temp.clear('integration_schema', 'sync_queue', 'last_response');
SELECT pg_temp.scrubcol('integration_schema', 'provider_shipments', 'meta');
SELECT pg_temp.wipe('integration_schema', 'provider_webhook_logs');

-- ---------------------------------------------------------------------------
-- 7. ai_schema — mijoz matnlari (AI draft), kunlik xarajat hisoblagichi
-- ---------------------------------------------------------------------------
SELECT pg_temp.clear('ai_schema', 'ai_order_draft', 'source_text');
SELECT pg_temp.clear('ai_schema', 'ai_order_draft', 'raw_extraction');
SELECT pg_temp.clear('ai_schema', 'ai_order_draft', 'resolved_preview');
DO $$
BEGIN
  IF pg_temp.col('ai_schema', 'ai_order_draft', 'text_purged_at') THEN
    PERFORM pg_temp.run('ai_schema.ai_order_draft.text_purged_at', 'SET now() (NULL)',
      'UPDATE ai_schema.ai_order_draft SET text_purged_at = now() WHERE text_purged_at IS NULL');
  END IF;
END $$;
SELECT pg_temp.wipe('ai_schema', 'ai_spend_counter');

-- ---------------------------------------------------------------------------
-- 8. Har sxemadagi umumiy jadvallar: audit jurnallari, webhook loglari,
--    idempotency javoblari, outbox tarixi, qidiruv indeksi
-- ---------------------------------------------------------------------------
DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY pg_temp.app_schemas() LOOP
    -- Audit jurnallari (old/new qiymatlarda ism/telefon/manzil) — staging'da kerak emas.
    PERFORM pg_temp.wipe(s, 'activity_logs');
    PERFORM pg_temp.wipe(s, 'activity_logs_archive');
    PERFORM pg_temp.wipe(s, 'webhook_logs');
    PERFORM pg_temp.wipe(s, 'idempotency_keys');
    -- Outbox: yuborilgan/yiqilgan tarix o'chadi; ichki (servislararo) kutayotgan
    -- hodisalar qoladi (ma'lumot izchilligi), lekin telefonlari maskalanadi.
    PERFORM pg_temp.wipe(s, 'outbox_events', 'status <> ''pending''');
    PERFORM pg_temp.scrubcol(s, 'outbox_events', 'payload');
  END LOOP;
END $$;
SELECT pg_temp.wipe('search_schema', 'search_documents');

-- ---------------------------------------------------------------------------
-- 9. UMUMIY telefon bosqichi (kelajakdagi ustunlar ham): app sxemalaridagi
--    nomida `phone` bo'lgan HAR matn ustuni → +99877NNNNNNN (id bo'yicha).
--    Ombor (stock_*) jadvallari tashlab o'tiladi; har UPDATE alohida
--    subtranzaksiyada — yiqilsa verify.sql uni sanab, butun ishni to'xtatadi.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record; n bigint; key_expr text;
BEGIN
  FOR r IN
    SELECT c.table_schema s, c.table_name t, c.column_name c,
           c.character_maximum_length len
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
       AND tb.table_type = 'BASE TABLE'
     WHERE c.table_schema = ANY (pg_temp.app_schemas())
       AND c.column_name ILIKE '%phone%'
       AND c.data_type IN ('text', 'character varying', 'character')
       AND c.table_name NOT LIKE 'stock\_%'
  LOOP
    key_expr := CASE WHEN pg_temp.col(r.s, r.t, 'id')
                     THEN 'hashtext(id::text)::bigint'
                     ELSE 'hashtext(ctid::text)::bigint' END;
    -- id raqamli bo'lsa — aynan id (bashorat qilinadigan, noyob).
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = r.s AND table_name = r.t AND column_name = 'id'
                  AND data_type IN ('bigint', 'integer', 'smallint')) THEN
      key_expr := 'id';
    END IF;
    BEGIN
      EXECUTE format(
        'UPDATE %I.%I SET %I = %s WHERE %I IS NOT NULL AND %I <> '''' AND %I !~ ''^\+?99877[0-9]{7}$''',
        r.s, r.t, r.c,
        CASE WHEN coalesce(r.len, 99) >= 13 THEN format('pg_temp.mask_phone(%s)', key_expr)
             ELSE format('substr(pg_temp.mask_phone(%s), 2)', key_expr) END,
        r.c, r.c, r.c);
      GET DIAGNOSTICS n = ROW_COUNT;
      INSERT INTO stg_log (target, action, affected)
        VALUES (r.s || '.' || r.t || '.' || r.c, 'GENERIC phone mask', n);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'generic phone mask % .% .% yiqildi: %', r.s, r.t, r.c, SQLERRM;
    END;
  END LOOP;
END $$;

-- Passport/JShShIR/INN kabi ID ustunlari (hozir yo'q — kelajak uchun).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.table_schema s, c.table_name t, c.column_name c
      FROM information_schema.columns c
     WHERE c.table_schema = ANY (pg_temp.app_schemas())
       AND c.column_name ~* '(passport|pinfl|jshshir|^inn$|_inn$|tin$|birth|document_(no|number))'
       AND c.data_type IN ('text', 'character varying', 'character')
  LOOP
    PERFORM pg_temp.clear(r.s, r.t, r.c);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 10. Hisobot: nima qilindi (verify.sql tekshiruvlari quyida, SHU tranzaksiyada)
-- ---------------------------------------------------------------------------
\o
\echo ''
\echo '=== Anonimizatsiya amallari (ta''sirlangan qatorlar) ==='
SELECT target, action, affected FROM stg_log WHERE affected > 0 ORDER BY seq;

\echo ''
\echo '=== Saqlangan TEST akkauntlar — staging login telefoni (parol: STAGING_DEFAULT_PASSWORD) ==='
SELECT id, role, phone_number AS staging_login_phone, name
  FROM identity_schema.admins
 WHERE id = ANY (string_to_array(:'keep_user_ids', ',')::bigint[])
 ORDER BY id;
