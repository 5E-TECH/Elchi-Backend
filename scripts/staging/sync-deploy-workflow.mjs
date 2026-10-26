#!/usr/bin/env node
// Staging deploy script = production deploy script + a fixed set of rewrites.
//
// .github/workflows/deploy.yml has two SSH deploy jobs: `deploy` (main ->
// production) and `deploy-staging` (test -> staging server). The staging job's
// `script: |` block is GENERATED from the production one by this file, so the
// two can never drift: change the production script, then run
//
//   node scripts/staging/sync-deploy-workflow.mjs          # rewrite the staging block
//   node scripts/staging/sync-deploy-workflow.mjs --check  # CI: fail if out of sync
//
// Every rewrite must match at least once. When the production script changes
// shape so that a rule no longer applies, this fails loudly instead of
// producing a staging script that silently acts like production (wrong branch,
// .env.production, a compose call without the staging override).
// Runbook: docs/ops/staging.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'deploy.yml');
const IND = ' '.repeat(12); // indentation of the `script: |` body

/** Inserted right after `cd <app path>`: runs before anything is touched. */
const PROLOGUE = `
# --- STAGING ----------------------------------------------------------------
# GENERATED from the production job's script by
# scripts/staging/sync-deploy-workflow.mjs — never edit this block by hand.
# Differences: branch test, .env.staging, every compose call also loads
# docker-compose.staging.yml, /tmp/elchi-stg-*, and the guards below.
#
# Never on a production checkout (e.g. a staging secret that is missing in
# the GitHub \`staging\` environment falls back to a repository secret).
if [ -f .env.production ] || [ ! -f .env.staging ]; then
  echo "!!! $(pwd) is not a staging checkout (.env.production present or .env.staging missing) — staging deploy refused, nothing was touched. docs/ops/staging.md" >&2
  exit 1
fi
if grep -q '__REPLACE_WITH' .env.staging; then
  echo "!!! .env.staging still has __REPLACE_WITH…__ placeholders ($(grep -o '^[A-Z0-9_]*=__REPLACE_WITH' .env.staging | cut -d= -f1 | tr '\\n' ' ')) — fill them first; nothing was touched." >&2
  exit 1
fi
# \`env_file: !override\` in docker-compose.staging.yml needs Compose >= 2.24.4.
STG_COMPOSE_VERSION="$(docker compose version --short 2>/dev/null || echo 0)"
if [ "$(printf '%s\\n' 2.24.4 "\${STG_COMPOSE_VERSION#v}" | sort -V | head -n 1)" != 2.24.4 ]; then
  echo "!!! Docker Compose \${STG_COMPOSE_VERSION} is older than 2.24.4 (docker-compose.staging.yml needs it) — nothing was touched." >&2
  exit 1
fi
# Compose \${…} interpolation reads .env.staging (production: .env), also in
# the helper scripts; pre-deploy-backup.sh / backup-db.sh get both compose
# files through BACKUP_COMPOSE_FILE.
export COMPOSE_ENV_FILES=.env.staging
export BACKUP_COMPOSE_FILE=docker-compose.prod.yml:docker-compose.staging.yml
# No app container yet (fresh server, or someone removed them) -> deploy
# everything, like production's first install.
STG_FIRST_INSTALL=false
if [ -z "$(docker compose -f docker-compose.prod.yml -f docker-compose.staging.yml ps -aq api-gateway 2>/dev/null || true)" ]; then
  STG_FIRST_INSTALL=true
fi
# --- end STAGING --------------------------------------------------------------
`
  .trim()
  .split('\n')
  .map((l) => (l ? IND + l : ''))
  .join('\n');

/** [description, from, to] — plain string replace-all, each must hit >= 1. */
const RULES = [
  [
    'every compose call also loads the staging override',
    'docker compose -f docker-compose.prod.yml',
    'docker compose -f docker-compose.prod.yml -f docker-compose.staging.yml',
  ],
  [
    'a change to the staging override redeploys everything',
    "docker-compose\\.prod\\.yml$",
    "docker-compose\\.(prod|staging)\\.yml$",
  ],
  ['branch: fetch', 'git fetch origin main', 'git fetch origin test'],
  ['branch: remote ref', 'origin/main', 'origin/test'],
  ['branch: checkout', 'git checkout -f main', 'git checkout -f test'],
  ['env file', '.env.production', '.env.staging'],
  ['own /tmp files (prod may share the host)', '/tmp/elchi-', '/tmp/elchi-stg-'],
  [
    'first install also when no app container exists',
    'if [ -z "$OLD_SHA" ]; then',
    'if [ -z "$OLD_SHA" ] || [ "$STG_FIRST_INSTALL" = true ]; then',
  ],
];

/** Body lines of the `script: |` block of job `name` ([start, end) indexes). */
function scriptBlock(lines, name) {
  const job = lines.indexOf(`  ${name}:`);
  if (job < 0) throw new Error(`job "${name}" not found in deploy.yml`);
  let i = job + 1;
  while (i < lines.length && !/^ {10}script: \|\s*$/.test(lines[i])) {
    if (/^ {2}\S/.test(lines[i])) {
      throw new Error(`job "${name}" has no \`script: |\` block`);
    }
    i++;
  }
  if (i >= lines.length) throw new Error(`job "${name}": no \`script: |\``);
  const start = i + 1;
  let end = start;
  while (
    end < lines.length &&
    (lines[end].trim() === '' || lines[end].startsWith(IND))
  ) {
    end++;
  }
  // trailing blank lines belong to whatever follows the block
  while (end > start && lines[end - 1].trim() === '') end--;
  return [start, end];
}

function toStaging(prodScript) {
  let out = prodScript;
  for (const [what, from, to] of RULES) {
    if (!out.includes(from)) {
      throw new Error(
        `rule "${what}" no longer matches the production script ("${from}") — update RULES in ${fileURLToPath(import.meta.url)}`,
      );
    }
    out = out.split(from).join(to);
  }
  // Nothing production-only may survive the rewrite.
  const leftovers = [
    [/origin\/main|checkout -f main|fetch origin main/, 'a main-branch reference'],
    [/\.env\.production/, '.env.production'],
    [/-f docker-compose\.prod\.yml(?! -f docker-compose\.staging\.yml)/, 'a compose call without the staging override'],
  ];
  for (const [re, what] of leftovers) {
    const hit = out.split('\n').find((l) => re.test(l));
    if (hit) throw new Error(`staging script still has ${what}: ${hit.trim()}`);
  }
  // Last, so the rules above never rewrite the prologue itself.
  const cd = `${IND}cd \${{ secrets.SERVER_APP_PATH }}\n`;
  if (out.split(cd).length !== 2) {
    throw new Error(`expected exactly one "${cd.trim()}" line in the production script`);
  }
  return out.replace(cd, `${cd}${PROLOGUE}\n`);
}

const check = process.argv.includes('--check');
const text = readFileSync(WORKFLOW, 'utf8');
const lines = text.split('\n');
const [ps, pe] = scriptBlock(lines, 'deploy');
const [ss, se] = scriptBlock(lines, 'deploy-staging');
const want = toStaging(lines.slice(ps, pe).join('\n'));
const have = lines.slice(ss, se).join('\n');

if (want === have) {
  console.log('deploy-staging script is in sync with the production script');
  process.exit(0);
}
if (check) {
  console.error(
    '::error::deploy-staging script in .github/workflows/deploy.yml is out of sync with the production `deploy` script — run `node scripts/staging/sync-deploy-workflow.mjs` and commit the result.',
  );
  process.exit(1);
}
lines.splice(ss, se - ss, ...want.split('\n'));
writeFileSync(WORKFLOW, lines.join('\n'));
console.log('deploy-staging script regenerated from the production script');
