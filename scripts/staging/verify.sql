-- ============================================================================
-- STAGING anonimizatsiya TEKSHIRUVI — har qator "qolgan haqiqiy narsa" soni,
-- HAMMASI 0 bo'lishi shart. anonymize.sql dan keyin SHU tranzaksiyada `\i`
-- bilan chaqiriladi (0 bo'lmasa RAISE → butun anonimizatsiya ROLLBACK, skript
-- tiklangan bazani o'chiradi). Alohida ham ishlatsa bo'ladi (faqat o'qiydi):
--   psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/staging/verify.sql
-- Jadval/ustun yo'q bo'lsa tekshiruv 0 deb hisoblanadi (IF EXISTS).
-- ============================================================================

\set ON_ERROR_STOP on

CREATE TEMP TABLE IF NOT EXISTS stg_checks (check_name text, remaining bigint);
TRUNCATE stg_checks;

-- Bitta tekshiruv: `q` — bitta son qaytaradigan SELECT; jadval yo'q bo'lsa 0.
CREATE OR REPLACE FUNCTION pg_temp.chk(name text, s text, t text, q text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE n bigint := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema = s AND table_name = t) THEN
    EXECUTE q INTO n;
  END IF;
  INSERT INTO stg_checks VALUES (name, coalesce(n, 0));
END $$;

-- Ustun bo'lsa — `cond` ga mos qatorlar soni.
CREATE OR REPLACE FUNCTION pg_temp.chkcol(name text, s text, t text, c text, cond text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE n bigint := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = s AND table_name = t AND column_name = c) THEN
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE %s', s, t, cond) INTO n;
  END IF;
  INSERT INTO stg_checks VALUES (name, coalesce(n, 0));
END $$;

\o /dev/null

-- 1. Telefonlar: app sxemalaridagi `%phone%` matn ustunlarining HAMMASI maskada.
DO $$
DECLARE r record; n bigint; total bigint := 0; detail text := '';
BEGIN
  FOR r IN
    SELECT c.table_schema s, c.table_name t, c.column_name c
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
       AND tb.table_type = 'BASE TABLE'
     WHERE c.table_schema IN ('identity_schema','order_schema','catalog_schema',
             'logistics_schema','finance_schema','notification_schema',
             'integration_schema','branch_schema','investor_schema','c2c_schema',
             'search_schema','ai_schema')
       AND c.column_name ILIKE '%phone%'
       AND c.data_type IN ('text', 'character varying', 'character')
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I.%I WHERE %I IS NOT NULL AND %I <> '''' AND %I !~ ''^\+?99877[0-9]{7}$''',
      r.s, r.t, r.c, r.c, r.c) INTO n;
    total := total + n;
    IF n > 0 THEN detail := detail || format(' %s.%s.%s=%s', r.s, r.t, r.c, n); END IF;
  END LOOP;
  INSERT INTO stg_checks VALUES ('phones not matching mask (+99877NNNNNNN)' || detail, total);
END $$;

-- 2. Erkin matn/jsonb ichida +998… telefon qolmagan (maska raqamlaridan tashqari).
--    Sir/xesh/token/id ustunlari chiqarib tashlanadi (tasodifiy raqam ketma-ketligi).
DO $$
DECLARE r record; n bigint; total bigint := 0; detail text := '';
BEGIN
  FOR r IN
    SELECT c.table_schema s, c.table_name t, c.column_name c, c.data_type typ
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
       AND tb.table_type = 'BASE TABLE'
     WHERE c.table_schema IN ('identity_schema','order_schema','catalog_schema',
             'logistics_schema','finance_schema','notification_schema',
             'integration_schema','branch_schema','investor_schema','c2c_schema',
             'search_schema','ai_schema')
       AND c.data_type IN ('text', 'character varying', 'character', 'jsonb', 'json')
       AND c.column_name !~* '(token|hash|password|secret|_key$|^key$|_id$|_ref$|_enc$|^code$|sha256|qr)'
       AND c.table_name NOT LIKE 'stock\_%'
  LOOP
    EXECUTE format(
      $q$SELECT count(*) FROM %I.%I
          WHERE %I IS NOT NULL
            AND regexp_replace(%I::text, '\+?99877[0-9]{7}|998770000000', '', 'g')
                ~ '\+998[\s\-]?\(?[0-9]{2}\)?[\s\-]?[0-9]{3}[\s\-]?[0-9]{2}[\s\-]?[0-9]{2}|(^|[^0-9])998[0-9]{9}([^0-9]|$)'$q$,
      r.s, r.t, r.c, r.c) INTO n;
    total := total + n;
    IF n > 0 THEN detail := detail || format(' %s.%s.%s=%s', r.s, r.t, r.c, n); END IF;
  END LOOP;
  INSERT INTO stg_checks VALUES ('free-text/json rows still containing +998 phones' || detail, total);
END $$;

-- 3. Foydalanuvchilar: parol, sessiyalar, Telegram, ism.
SELECT pg_temp.chkcol('admins: password <> staging hash', 'identity_schema', 'admins', 'password',
  CASE WHEN to_regclass('pg_temp.stg_secret') IS NOT NULL
       THEN 'password IS DISTINCT FROM (SELECT pw_hash FROM stg_secret)'
       ELSE 'password !~ ''^\$2[ab]\$12\$''' END);
SELECT pg_temp.chkcol('admins: refresh_token not null', 'identity_schema', 'admins', 'refresh_token', 'refresh_token IS NOT NULL');
SELECT pg_temp.chkcol('admins: telegram_id not null', 'identity_schema', 'admins', 'telegram_id', 'telegram_id IS NOT NULL');
SELECT pg_temp.chkcol('admins: telegram_username not null', 'identity_schema', 'admins', 'telegram_username', 'telegram_username IS NOT NULL');
SELECT pg_temp.chkcol('admins: name not masked', 'identity_schema', 'admins', 'name', 'name !~ '' #[0-9]+$''');
SELECT pg_temp.chkcol('admins: address not masked', 'identity_schema', 'admins', 'address', 'address IS NOT NULL AND address !~ ''^Staging manzil #''');
SELECT pg_temp.chkcol('admins: must_change_password', 'identity_schema', 'admins', 'must_change_password', 'must_change_password');
SELECT pg_temp.chk('user_sessions rows', 'identity_schema', 'user_sessions', 'SELECT count(*) FROM identity_schema.user_sessions');
SELECT pg_temp.chk('otp_codes rows', 'identity_schema', 'otp_codes', 'SELECT count(*) FROM identity_schema.otp_codes');

-- 4. Aylantirilgan sirlar — eski qiymat qolmagan.
DO $$
DECLARE n bigint := 0;
BEGIN
  IF to_regclass('pg_temp.stg_old_secrets') IS NOT NULL THEN
    SELECT count(*) INTO n FROM stg_old_secrets o
     WHERE (o.kind = 'market_tg_token' AND EXISTS (
              SELECT 1 FROM identity_schema.admins a WHERE a.market_tg_token = o.val))
        OR (o.kind = 'partner_api_key_hash' AND EXISTS (
              SELECT 1 FROM integration_schema.partners p WHERE p.api_key_hash = o.val));
  END IF;
  INSERT INTO stg_checks VALUES ('old market/partner tokens still present', n);
END $$;

-- 5. Buyurtmalar.
SELECT pg_temp.chkcol('orders: address not masked', 'order_schema', 'orders', 'address', 'address IS NOT NULL AND address !~ ''^Staging manzil''');
SELECT pg_temp.chkcol('orders: comment not masked', 'order_schema', 'orders', 'comment', 'comment IS NOT NULL AND comment !~ ''^\[staging\]''');
SELECT pg_temp.chkcol('order_tracking: old/new_value left', 'order_schema', 'order_tracking', 'old_value', 'old_value IS NOT NULL OR new_value IS NOT NULL');

-- 6. Telegram.
SELECT pg_temp.chk('telegram_markets rows (group ids)', 'notification_schema', 'telegram_markets', 'SELECT count(*) FROM notification_schema.telegram_markets');
SELECT pg_temp.chk('telegram_chats rows (chat links)', 'notification_schema', 'telegram_chats', 'SELECT count(*) FROM notification_schema.telegram_chats');
SELECT pg_temp.chk('telegram_outbox rows', 'notification_schema', 'telegram_outbox', 'SELECT count(*) FROM notification_schema.telegram_outbox');
SELECT pg_temp.chk('telegram_sessions rows', 'notification_schema', 'telegram_sessions', 'SELECT count(*) FROM notification_schema.telegram_sessions');
SELECT pg_temp.chk('telegram_link_tokens rows', 'notification_schema', 'telegram_link_tokens', 'SELECT count(*) FROM notification_schema.telegram_link_tokens');
SELECT pg_temp.chk('telegram_order_cards rows', 'notification_schema', 'telegram_order_cards', 'SELECT count(*) FROM notification_schema.telegram_order_cards');
SELECT pg_temp.chk('telegram_ai_drafts rows', 'notification_schema', 'telegram_ai_drafts', 'SELECT count(*) FROM notification_schema.telegram_ai_drafts');

-- 7. Push / SMS / kampaniyalar / notification outbox.
SELECT pg_temp.chk('push_subscriptions rows', 'notification_schema', 'push_subscriptions', 'SELECT count(*) FROM notification_schema.push_subscriptions');
SELECT pg_temp.chk('sms_outbox pending/processing', 'notification_schema', 'sms_outbox', $q$SELECT count(*) FROM notification_schema.sms_outbox WHERE status IN ('pending','processing')$q$);
SELECT pg_temp.chkcol('sms_outbox: text not masked', 'notification_schema', 'sms_outbox', 'text', 'text !~ ''^\[staging\]''');
SELECT pg_temp.chk('sms_provider_accounts rows (credentials)', 'notification_schema', 'sms_provider_accounts', 'SELECT count(*) FROM notification_schema.sms_provider_accounts');
SELECT pg_temp.chk('sms_campaigns scheduled/queued/running', 'notification_schema', 'sms_campaigns', $q$SELECT count(*) FROM notification_schema.sms_campaigns WHERE status IN ('scheduled','queued','running')$q$);
SELECT pg_temp.chk('notification_campaigns queued/running', 'notification_schema', 'notification_campaigns', $q$SELECT count(*) FROM notification_schema.notification_campaigns WHERE status IN ('queued','running')$q$);
SELECT pg_temp.chk('notification outbox_events rows', 'notification_schema', 'outbox_events', 'SELECT count(*) FROM notification_schema.outbox_events');

-- 8. Integratsiya (data darajasida o'chiq).
SELECT pg_temp.chkcol('partners: is_active', 'integration_schema', 'partners', 'is_active', 'is_active');
SELECT pg_temp.chkcol('partners: sandbox_enabled', 'integration_schema', 'partners', 'sandbox_enabled', 'sandbox_enabled');
SELECT pg_temp.chkcol('partners: webhook_url set', 'integration_schema', 'partners', 'webhook_url', 'coalesce(webhook_url, '''') <> ''''');
SELECT pg_temp.chkcol('partners: sandbox_webhook_url set', 'integration_schema', 'partners', 'sandbox_webhook_url', 'coalesce(sandbox_webhook_url, '''') <> ''''');
SELECT pg_temp.chkcol('partners: webhook secrets set', 'integration_schema', 'partners', 'webhook_secret', 'coalesce(webhook_secret, '''') <> ''''');
SELECT pg_temp.chkcol('external_integrations: is_active', 'integration_schema', 'external_integrations', 'is_active', 'is_active');
SELECT pg_temp.chkcol('external_integrations: webhook_enabled', 'integration_schema', 'external_integrations', 'webhook_enabled', 'webhook_enabled');
SELECT pg_temp.chkcol('external_integrations: api_url live', 'integration_schema', 'external_integrations', 'api_url', 'coalesce(api_url, '''') NOT IN ('''', ''https://staging-disabled.invalid'')');
SELECT pg_temp.chkcol('external_integrations: auth_url live', 'integration_schema', 'external_integrations', 'auth_url', 'coalesce(auth_url, '''') NOT IN ('''', ''https://staging-disabled.invalid'')');
SELECT pg_temp.chkcol('external_integrations: secrets set', 'integration_schema', 'external_integrations', 'api_key',
  'coalesce(api_key, '''') <> '''' OR coalesce(api_secret, '''') <> '''' OR coalesce(password, '''') <> '''' OR coalesce(webhook_secret, '''') <> ''''');
SELECT pg_temp.chk('partner_webhook_outbox rows', 'integration_schema', 'partner_webhook_outbox', 'SELECT count(*) FROM integration_schema.partner_webhook_outbox');
SELECT pg_temp.chk('sync_queue pending/processing', 'integration_schema', 'sync_queue', $q$SELECT count(*) FROM integration_schema.sync_queue WHERE status IN ('pending','processing','retry')$q$);
SELECT pg_temp.chk('provider_webhook_logs rows', 'integration_schema', 'provider_webhook_logs', 'SELECT count(*) FROM integration_schema.provider_webhook_logs');

-- 9. AI matnlari, audit jurnallari, qidiruv indeksi.
SELECT pg_temp.chkcol('ai_order_draft: source_text left', 'ai_schema', 'ai_order_draft', 'source_text', 'coalesce(source_text, '''') <> ''''');
DO $$
DECLARE s text; n bigint; total bigint := 0;
BEGIN
  FOR s IN SELECT table_schema FROM information_schema.tables
            WHERE table_name IN ('activity_logs', 'activity_logs_archive', 'webhook_logs', 'idempotency_keys')
              AND table_schema LIKE '%\_schema'
            GROUP BY table_schema LOOP
    IF to_regclass(format('%I.activity_logs', s)) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %I.activity_logs', s) INTO n; total := total + n;
    END IF;
    IF to_regclass(format('%I.activity_logs_archive', s)) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %I.activity_logs_archive', s) INTO n; total := total + n;
    END IF;
    IF to_regclass(format('%I.webhook_logs', s)) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %I.webhook_logs', s) INTO n; total := total + n;
    END IF;
    IF to_regclass(format('%I.idempotency_keys', s)) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %I.idempotency_keys', s) INTO n; total := total + n;
    END IF;
  END LOOP;
  INSERT INTO stg_checks VALUES ('activity/webhook logs + idempotency rows (all schemas)', total);
END $$;
SELECT pg_temp.chk('search_documents rows', 'search_schema', 'search_documents', 'SELECT count(*) FROM search_schema.search_documents');

\o
\echo ''
\echo '=== Tekshiruv: HAMMASI 0 bo''lishi shart ==='
SELECT CASE WHEN remaining = 0 THEN 'OK' ELSE 'FAIL' END AS result,
       remaining, check_name
  FROM stg_checks ORDER BY (remaining = 0), check_name;

DO $$
DECLARE bad bigint;
BEGIN
  SELECT count(*) INTO bad FROM stg_checks WHERE remaining <> 0;
  IF bad > 0 THEN
    RAISE EXCEPTION 'STAGING TEKSHIRUVI YIQILDI: % ta tekshiruvda haqiqiy ma''lumot qoldi', bad;
  END IF;
  RAISE NOTICE 'STAGING TEKSHIRUVI: % ta tekshiruv, hammasi 0', (SELECT count(*) FROM stg_checks);
END $$;
