/**
 * Frontend ↔ Backend API coverage audit.
 *
 * Compares the backend's generated OpenAPI surface (docs/frontend/openapi.json)
 * against what the React frontend actually wires up, and reports:
 *   A. Backend endpoints the frontend never references  → MISSING (gaps to add)
 *   B. Backend paths wired with a different/partial HTTP method → REVIEW
 *   C. Frontend calls that match no backend route → STALE / WRONG path
 *   D. Stats + unresolved (dynamic) calls
 *
 * The frontend's API surface is read from two places:
 *   1. src/shared/api/endpoints.ts  — the central API_ENDPOINTS registry
 *   2. inline api.<method>('...') call sites across src/**            (method-aware)
 *
 * Usage:
 *   node scripts/audit-frontend-coverage.mjs [frontendDir]
 *   (frontendDir defaults to ../Elchi-Frontend)
 * Output: docs/frontend/COVERAGE_REPORT.md  (+ console summary)
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const FRONTEND_DIR = resolve(
  process.argv[2] ?? join(REPO, '..', 'Elchi-Frontend'),
);
const OPENAPI = join(REPO, 'docs', 'frontend', 'openapi.json');
const OUT = join(REPO, 'docs', 'frontend', 'COVERAGE_REPORT.md');

// ---------- path normalization ----------
// Any dynamic segment ( {id} | :id | ${...} | empty ) collapses to ':p' so that
// backend templates and frontend templates compare structurally.
function normSegs(p) {
  if (!p) return [];
  let s = String(p).split('?')[0].split('#')[0];
  s = s.replace(/^\/+|\/+$/g, '');
  if (!s) return [];
  return s.split('/').map((seg) => {
    if (seg === '' || /[:${}]/.test(seg)) return ':p';
    return seg.toLowerCase();
  });
}
const normPath = (p) => normSegs(p).join('/');

// ---------- backend surface from openapi ----------
const doc = JSON.parse(readFileSync(OPENAPI, 'utf8'));
const backend = []; // { method, rawPath, np, tag }
for (const [rawPath, item] of Object.entries(doc.paths ?? {})) {
  for (const [method, op] of Object.entries(item ?? {})) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
    backend.push({
      method: method.toUpperCase(),
      rawPath,
      np: normPath(rawPath),
      tag: (op.tags && op.tags[0]) || 'Other',
      summary: op.summary || '',
    });
  }
}
const backendPathsByNp = new Map(); // np -> Set(methods)
for (const b of backend) {
  if (!backendPathsByNp.has(b.np)) backendPathsByNp.set(b.np, new Set());
  backendPathsByNp.get(b.np).add(b.method);
}

// ---------- collect frontend source files ----------
function walk(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) acc.push(full);
  }
  return acc;
}
const SRC = join(FRONTEND_DIR, 'src');
const files = walk(SRC);

// ---------- parse the API_ENDPOINTS registry ----------
// Flat map: "ORDERS.BASE" -> "orders", "ORDERS.BY_ID" -> "orders/${id}" ...
const registry = new Map();
{
  const epFile = files.find((f) => f.endsWith('shared/api/endpoints.ts'));
  if (epFile) {
    const lines = readFileSync(epFile, 'utf8').split('\n');
    let group = null;
    let pendingKey = null;
    for (const line of lines) {
      const g = line.match(/^\s{2}([A-Z0-9_]+):\s*\{/);
      if (g) {
        group = g[1];
        continue;
      }
      if (/^\s{2}\}/.test(line)) {
        group = null;
        continue;
      }
      if (!group) continue;
      // KEY: "literal"
      const sLit = line.match(/^\s+([A-Z0-9_]+):\s*["'`]([^"'`]+)["'`]/);
      if (sLit) {
        registry.set(`${group}.${sLit[1]}`, sLit[2]);
        continue;
      }
      // KEY: (args) => `template`   (template may be on the same or next line)
      const fn = line.match(/^\s+([A-Z0-9_]+):\s*\(.*=>/);
      if (fn) {
        const tpl = line.match(/=>\s*`([^`]+)`/);
        if (tpl) registry.set(`${group}.${fn[1]}`, tpl[1]);
        else pendingKey = `${group}.${fn[1]}`;
        continue;
      }
      if (pendingKey) {
        const tpl = line.match(/`([^`]+)`/);
        if (tpl) {
          registry.set(pendingKey, tpl[1]);
          pendingKey = null;
        }
      }
    }
  }
}

// ---------- scan call sites: api.<method>( firstArg ... ) ----------
const wired = []; // { method, np, src }   method-aware, resolved
const frontPaths = new Set(); // path-level known surface (np)
const unresolved = []; // { src, snippet }

// every registry value is part of the known path-level surface
for (const v of registry.values()) frontPaths.add(normPath(v));

// Capture the first argument as ONE of: a full string/template literal,
// an API_ENDPOINTS.X.Y reference, or a bare identifier (→ unresolved).
const callRe =
  /\b(?:api|axios|instance|http|client)\.(get|post|put|patch|delete)\(\s*(`[^`]*`|"[^"]*"|'[^']*'|API_ENDPOINTS\.[A-Z0-9_]+\.[A-Z0-9_]+|[A-Za-z_$][\w.$]*)/g;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const rel = file.replace(FRONTEND_DIR + '/', '');
  let m;
  while ((m = callRe.exec(text))) {
    const method = m[1].toUpperCase();
    let arg = m[2].trim();
    // strip a trailing template-literal opener artifact
    let path = null;
    const apiRef = arg.match(/API_ENDPOINTS\.([A-Z0-9_]+)\.([A-Z0-9_]+)/);
    if (apiRef) {
      const key = `${apiRef[1]}.${apiRef[2]}`;
      if (registry.has(key)) path = registry.get(key);
      else {
        unresolved.push({ rel, snippet: arg.slice(0, 60) });
        continue;
      }
    } else if (/^["'`]/.test(arg)) {
      path = arg.replace(/^["'`]/, '').replace(/["'`].*$/, '');
    } else {
      unresolved.push({ rel, snippet: arg.slice(0, 60) });
      continue;
    }
    const np = normPath(path);
    wired.push({ method, np, rel });
    frontPaths.add(np);
  }
}

const wiredByNp = new Map(); // np -> Set(methods)
for (const w of wired) {
  if (!wiredByNp.has(w.np)) wiredByNp.set(w.np, new Set());
  wiredByNp.get(w.np).add(w.method);
}

// ---------- compute findings ----------
// A. backend path-level entirely missing from frontend
const missingByTag = new Map();
for (const b of backend) {
  if (!frontPaths.has(b.np)) {
    if (!missingByTag.has(b.tag)) missingByTag.set(b.tag, []);
    missingByTag.get(b.tag).push(b);
  }
}

// B. path known to frontend but this specific METHOD not wired (method-aware)
const methodGaps = [];
for (const b of backend) {
  if (!frontPaths.has(b.np)) continue; // already in A
  const wiredMethods = wiredByNp.get(b.np);
  if (!wiredMethods || !wiredMethods.has(b.method)) {
    methodGaps.push(b);
  }
}

// C. frontend paths that match no backend route
const backendNpSet = new Set(backend.map((b) => b.np));
const stale = new Map(); // np -> example source
// from registry
for (const [key, val] of registry) {
  const np = normPath(val);
  if (!backendNpSet.has(np)) {
    if (!stale.has(np)) stale.set(np, `registry: API_ENDPOINTS.${key}`);
  }
}
// from inline wired calls
for (const w of wired) {
  if (!backendNpSet.has(w.np)) {
    if (!stale.has(w.np)) stale.set(w.np, `call: ${w.rel}`);
  }
}

// ---------- render report ----------
const totalOps = backend.length;
const coveredPathLevel = backend.filter((b) => frontPaths.has(b.np)).length;
const out = [];
out.push('# Frontend ↔ Backend API Coverage Report');
out.push('');
out.push(`Backend: \`docs/frontend/openapi.json\` · Frontend: \`${FRONTEND_DIR}\``);
out.push('');
out.push('## Summary');
out.push('');
out.push(`- Backend operations (method+path): **${totalOps}**`);
out.push(
  `- Backend ops whose path the frontend references (path-level): **${coveredPathLevel}**`,
);
const missingCount = [...missingByTag.values()].reduce((s, a) => s + a.length, 0);
out.push(`- ❌ Backend ops with NO frontend reference at all: **${missingCount}**`);
out.push(`- ⚠️ Path wired but specific method missing (review): **${methodGaps.length}**`);
out.push(`- 🔴 Frontend paths matching no backend route (stale/wrong): **${stale.size}**`);
out.push(`- Registry entries parsed: ${registry.size} · resolved call sites: ${wired.length} · unresolved dynamic calls: ${unresolved.length}`);
out.push('');
out.push('Legend: `:p` = a dynamic path segment (id/token/etc).');
out.push('');

out.push('## ❌ A. Missing in frontend (backend endpoints never referenced)');
out.push('');
out.push('These backend capabilities have no matching path anywhere in the frontend. **This is the "qolib ketgan funksiyalar" list — add these.**');
out.push('');
const tagsSorted = [...missingByTag.keys()].sort();
if (!tagsSorted.length) out.push('_None — every backend path is referenced._');
for (const tag of tagsSorted) {
  const items = missingByTag.get(tag).sort((a, b) => a.rawPath.localeCompare(b.rawPath));
  out.push(`### ${tag} (${items.length})`);
  for (const it of items) {
    out.push(`- \`${it.method} ${it.rawPath}\` — ${it.summary}`);
  }
  out.push('');
}

out.push('## ⚠️ B. Method gaps (path is used, but this method is not wired)');
out.push('');
out.push('The frontend knows the path but the specific HTTP method below was not found at any resolved call site. Could be: not implemented yet, or wired via an unresolved/dynamic call. Verify each.');
out.push('');
if (!methodGaps.length) out.push('_None._');
else {
  const byTag = new Map();
  for (const b of methodGaps) {
    if (!byTag.has(b.tag)) byTag.set(b.tag, []);
    byTag.get(b.tag).push(b);
  }
  for (const tag of [...byTag.keys()].sort()) {
    out.push(`### ${tag}`);
    for (const it of byTag.get(tag).sort((a, b) => a.rawPath.localeCompare(b.rawPath))) {
      out.push(`- \`${it.method} ${it.rawPath}\` — ${it.summary}`);
    }
    out.push('');
  }
}

out.push('## 🔴 C. Stale / wrong frontend paths (no backend match)');
out.push('');
out.push('These paths exist in the frontend (registry or inline calls) but match **no** backend route. Likely renamed, removed, or wrong — fix or delete.');
out.push('');
if (!stale.size) out.push('_None._');
else {
  for (const [np, src] of [...stale.entries()].sort()) {
    out.push(`- \`${np}\`  ←  ${src}`);
  }
  out.push('');
}

out.push('## D. Unresolved dynamic calls (could not determine path)');
out.push('');
out.push('Call sites where the path is a variable/expression the audit could not statically resolve. Review manually if coverage looks off.');
out.push('');
if (!unresolved.length) out.push('_None._');
else {
  const seen = new Set();
  for (const u of unresolved) {
    const k = `${u.rel}::${u.snippet}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(`- \`${u.rel}\` → \`${u.snippet}…\``);
  }
  out.push('');
}

writeFileSync(OUT, out.join('\n'), 'utf8');

// ---------- console summary ----------
console.log(`Coverage report → ${OUT}`);
console.log(`  backend ops: ${totalOps}`);
console.log(`  ❌ missing in frontend: ${missingCount}`);
console.log(`  ⚠️ method gaps (review): ${methodGaps.length}`);
console.log(`  🔴 stale/wrong frontend paths: ${stale.size}`);
console.log(`  unresolved dynamic calls: ${unresolved.length}`);
