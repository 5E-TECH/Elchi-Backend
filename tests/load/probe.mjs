/**
 * PRODUKSIYA UCHUN XAVFSIZ O'LCHOV (yuk testi EMAS).
 *
 * ⚠️ NEGA ALOHIDA SKRIPT. `capacity.js` yukni 200 req/s gacha ko'taradi —
 * bu produksiyada ATAYLAB uzilish demakdir. Bu skript esa boshqa narsani
 * qiladi: og'ir ekranlarni BITTA operator tezligida (1 so'rov/soniya)
 * ochadi va ularning REAL ma'lumot hajmidagi kechikishini o'lchaydi.
 *
 * Yuk = bitta odam brauzerda bosgani bilan bir xil. Xavf yo'q.
 *
 * NEGA BU YETARLI. Sig'im modelidagi yagona katta noma'lum — og'ir
 * so'rovning HAQIQIY bazadagi narxi. Uni bilsak, qolgani hisob:
 * bir so'rov N ms CPU yesa, bitta yadro sekundiga 1000/N ta so'rovni
 * ko'taradi.
 *
 * ISHGA TUSHIRISH:
 *   BASE_URL=https://api.elchipochta.uz \
 *   LOGIN_PHONE='+998...' LOGIN_PASSWORD='...' \
 *   node tests/load/probe.mjs
 *
 * Hech narsa YOZMAYDI: faqat GET, faqat o'qish. Login ham oddiy kirish.
 */

const BASE_URL = (process.env.BASE_URL || 'https://api.elchipochta.uz').replace(
  /\/+$/,
  '',
);
const PHONE = process.env.LOGIN_PHONE || '';
const PASSWORD = process.env.LOGIN_PASSWORD || '';
/** Throttle sukut bo'yicha daqiqasiga 60 — 1100 ms oraliq xavfsiz chegara. */
const GAP_MS = Number(process.env.GAP_MS || 1100);
const REPEATS = Number(process.env.REPEATS || 3);

if (!PHONE || !PASSWORD) {
  console.error(
    'LOGIN_PHONE va LOGIN_PASSWORD kerak.\n' +
      "Misol: LOGIN_PHONE='+998901234567' LOGIN_PASSWORD='...' node tests/load/probe.mjs",
  );
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dateKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate(),
  )}`;
}

async function login() {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_number: PHONE, password: PASSWORD }),
  });
  const ms = Date.now() - started;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Login ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  const token =
    body?.accessToken ?? body?.access_token ?? body?.data?.accessToken;
  if (!token) throw new Error('Javobda accessToken yo`q');
  console.log(`  login: ${ms} ms  (bcrypt + JWT — CPU narxi shu yerda)`);
  return token;
}

async function measure(name, path, token, note = '') {
  const samples = [];
  let meta = '';
  for (let i = 0; i < REPEATS; i++) {
    const started = Date.now();
    let res;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      console.log(`  ${name.padEnd(26)} XATO: ${err.message}`);
      return null;
    }
    const ms = Date.now() - started;

    if (res.status === 429) {
      console.log(
        `  ${name.padEnd(26)} 429 — rate limit. GAP_MS ni oshiring.`,
      );
      return null;
    }
    if (!res.ok) {
      console.log(`  ${name.padEnd(26)} HTTP ${res.status}`);
      return null;
    }

    const body = await res.json().catch(() => null);
    samples.push(ms);

    // Birinchi javobdan hajm belgisini olamiz — model uchun eng muhim raqam.
    if (i === 0 && body) {
      const total =
        body?.data?.pagination?.total ??
        body?.data?.total ??
        (Array.isArray(body?.data) ? body.data.length : undefined);
      if (total !== undefined) meta = ` · jami: ${total}`;
      const bytes = JSON.stringify(body).length;
      meta += ` · javob: ${(bytes / 1024).toFixed(1)} KB`;
    }
    if (i < REPEATS - 1) await sleep(GAP_MS);
  }

  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  console.log(
    `  ${name.padEnd(26)} o'rt ${String(avg).padStart(5)} ms  ` +
      `(min ${min} / max ${max})${meta}${note}`,
  );
  return { name, avg, min, max };
}

const main = async () => {
  const to = new Date();
  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const range = `startDate=${dateKey(from)}&endDate=${dateKey(to)}`;

  console.log(`\n  Manzil: ${BASE_URL}`);
  console.log(`  Rejim : faqat O'QISH, ${REPEATS} takror, ${GAP_MS} ms oraliq\n`);

  const token = await login();
  await sleep(GAP_MS);

  const results = [];
  // Tartib ataylab yengildan og'irga — agar og'iri muammo qilsa, undan
  // oldingi o'lchovlar allaqachon olingan bo'ladi.
  results.push(await measure('health (bazaviy)', '/health', token));
  await sleep(GAP_MS);
  results.push(
    await measure('orders ro`yxati (20 ta)', '/orders?page=1&limit=20', token),
  );
  await sleep(GAP_MS);
  results.push(
    await measure(
      'moliyaviy balans',
      '/finance/cashbox/financial-balanse',
      token,
    ),
  );
  await sleep(GAP_MS);
  results.push(
    await measure(
      'analitika dashboard',
      `/analytics/dashboard?${range}`,
      token,
      '  ← Scale 1 shu yerni tuzatdi',
    ),
  );
  await sleep(GAP_MS);
  results.push(
    await measure(
      'daromad (kunlik, 30 kun)',
      `/analytics/revenue?${range}&period=daily`,
      token,
      '  ← Scale 1 shu yerni tuzatdi',
    ),
  );

  const ok = results.filter(Boolean);
  const baseline = ok.find((r) => r.name.startsWith('health'))?.avg ?? 0;
  const heaviest = ok.reduce((a, b) => (a && a.avg > b.avg ? a : b), null);

  console.log('\n  ─── XULOSA ──────────────────────────────────');
  if (baseline && heaviest) {
    console.log(
      `  Tarmoq+tunnel bazasi : ~${baseline} ms (health — ish qilmaydigan endpoint)`,
    );
    console.log(
      `  Eng og'iri           : ${heaviest.name} — ${heaviest.avg} ms ` +
        `(bazadan ${heaviest.avg - baseline} ms ortiq = server ishi)`,
    );
    const serverMs = Math.max(heaviest.avg - baseline, 1);
    console.log(
      `  Bitta yadro shifti   : ~${Math.floor(1000 / serverMs)} shunday so'rov/soniya`,
    );
  }
  console.log(
    '\n  ⚠️  Bu YUK testi emas — bitta foydalanuvchi tezligidagi o\'lchov.',
  );
  console.log(
    "      To'liq sig'im uchun: Scale 1 deploy qilinsin, so'ng staging'da",
  );
  console.log('      `k6 run tests/load/capacity.js`.\n');
};

main().catch((err) => {
  console.error(`\n  XATO: ${err.message}\n`);
  process.exit(1);
});
