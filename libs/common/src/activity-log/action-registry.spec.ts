import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import {
  ACTIVITY_ACTION_CATEGORIES,
  ACTIVITY_ACTION_REGISTRY,
  ACTIVITY_LOG_AUTH_ACTIONS,
  describeActivityAction,
  humanizeActivityAction,
  listActivityActions,
} from './action-registry';
import { ActivityAction } from './types';

/**
 * y8CxCtcK — amal fe'llari reyestri.
 *
 * CI testi: kodda `activityLog.log({...})` / `.logChange({...})` ga
 * yozilayotgan HAR fe'l reyestrda bo'lishi shart. Sof grep emas — TypeScript
 * AST (ULTRACODE xavfi: `ActivityAction.STATUS_CHANGE`, shart-ifoda, shablon
 * satr grep'da ko'rinmaydi). Qo'llab-quvvatlanadigan shakllar:
 *   • `'order.sell'` / `` `order.sell` `` — satr;
 *   • `ActivityAction.X` va istalgan `CONST.X` (top-level `const X = {...}`);
 *   • `a ? x : y`, `a ?? x` — ikkala tarmoq;
 *   • shablon (`` `auth.${event}` ``) — FAQAT `DYNAMIC` jadvalida aniq
 *     yoyilgan bo'lsa; aks holda test yiqiladi.
 * Hal qilib bo'lmaydigan ifoda (masalan `action: dto.action`) — test YIQILADI
 * (yolg'on yashil bo'lmasin), faqat `PASS_THROUGH` dagi o'tkazgichlar bundan
 * mustasno.
 */

const ROOT = join(__dirname, '..', '..', '..', '..');

/** Fe'lni o'zi yozmaydigan, chaqiruvchidan o'tkazadigan joylar. */
const PASS_THROUGH = new Set([
  // logChange() → log({ action: input.action ?? UPDATED }) — chaqiruvchida tekshiriladi.
  'libs/common/src/activity-log/activity-log.service.ts',
]);

/**
 * Shablon fe'llarning aniq yoyilishi: fayl → shablonning har qiymati.
 * otp.service.ts: `event === 'otp_failed' ? AUTH_FAILURE : \`auth.${event}\``,
 * `this.audit('<event>', ...)` chaqiruvlaridan (quyida tekshiriladi).
 */
const DYNAMIC: Record<string, (src: string) => string[]> = {
  'apps/identity-service/src/otp/otp.service.ts': (src) =>
    [...src.matchAll(/this\.audit\(\s*'([a-z_]+)'/g)]
      .map((m) => m[1])
      .filter((event) => event !== 'otp_failed')
      .map((event) => `auth.${event}`),
};

interface Finding {
  file: string;
  line: number;
  verbs: string[];
  unresolved?: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === 'node_modules' || name === 'dist' ? [] : walk(full);
    }
    return full.endsWith('.ts') && !full.endsWith('.spec.ts') ? [full] : [];
  });
}

function propName(p: ts.ObjectLiteralElementLike, sf: ts.SourceFile) {
  return p.name ? p.name.getText(sf).replace(/['"]/g, '') : undefined;
}

/** Barcha fayllardagi top-level `const X = { K: 'v' }` konstantalari. */
function collectConstObjects(
  files: Array<{ rel: string; sf: ts.SourceFile }>,
): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  out.set('ActivityAction', { ...ActivityAction });
  for (const { sf } of files) {
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        let init = decl.initializer;
        while (
          init &&
          (ts.isAsExpression(init) || ts.isParenthesizedExpression(init))
        )
          init = init.expression;
        if (
          !init ||
          !ts.isObjectLiteralExpression(init) ||
          !ts.isIdentifier(decl.name)
        )
          continue;
        const map: Record<string, string> = {};
        for (const p of init.properties) {
          if (
            ts.isPropertyAssignment(p) &&
            (ts.isStringLiteral(p.initializer) ||
              ts.isNoSubstitutionTemplateLiteral(p.initializer))
          ) {
            map[propName(p, sf)!] = p.initializer.text;
          }
        }
        if (Object.keys(map).length && !out.has(decl.name.text))
          out.set(decl.name.text, map);
      }
    }
  }
  return out;
}

function scan(): Finding[] {
  const files = [...walk(join(ROOT, 'apps')), ...walk(join(ROOT, 'libs'))]
    .map((full) => ({
      rel: relative(ROOT, full).split('\\').join('/'),
      src: readFileSync(full, 'utf8'),
    }))
    .filter((f) => f.src.includes('action'))
    .map((f) => ({
      ...f,
      sf: ts.createSourceFile(f.rel, f.src, ts.ScriptTarget.Latest, true),
    }));
  const consts = collectConstObjects(files);
  const findings: Finding[] = [];

  for (const { rel, src, sf } of files) {
    const resolve = (expr: ts.Expression): string[] | null => {
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))
        return [expr.text];
      if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr))
        return resolve(expr.expression);
      if (ts.isConditionalExpression(expr)) {
        const a = resolve(expr.whenTrue);
        const b = resolve(expr.whenFalse);
        return a && b ? [...a, ...b] : null;
      }
      if (
        ts.isBinaryExpression(expr) &&
        expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        const a = resolve(expr.left);
        const b = resolve(expr.right);
        return a && b ? [...a, ...b] : null;
      }
      if (
        ts.isPropertyAccessExpression(expr) &&
        ts.isIdentifier(expr.expression)
      ) {
        const value = consts.get(expr.expression.text)?.[expr.name.text];
        return value ? [value] : null;
      }
      if (ts.isTemplateExpression(expr) && DYNAMIC[rel]) {
        return DYNAMIC[rel](src);
      }
      return null;
    };

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['log', 'logChange'].includes(node.expression.name.text) &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const obj = node.arguments[0];
        const props = obj.properties;
        const hasEntity = props.some((p) => propName(p, sf) === 'entity_type');
        const actionProp = props.find((p) => propName(p, sf) === 'action');
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (hasEntity && !PASS_THROUGH.has(rel)) {
          if (!actionProp) {
            // logChange — sukut UPDATED.
            if (node.expression.name.text === 'logChange')
              findings.push({
                file: rel,
                line,
                verbs: [ActivityAction.UPDATED],
              });
            else
              findings.push({
                file: rel,
                line,
                verbs: [],
                unresolved: '<action yo`q>',
              });
          } else if (ts.isPropertyAssignment(actionProp)) {
            const verbs = resolve(actionProp.initializer);
            findings.push(
              verbs
                ? { file: rel, line, verbs }
                : {
                    file: rel,
                    line,
                    verbs: [],
                    unresolved: actionProp.initializer.getText(sf),
                  },
            );
          } else {
            findings.push({
              file: rel,
              line,
              verbs: [],
              unresolved: actionProp.getText(sf),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return findings;
}

describe('y8CxCtcK — amal fe`llari reyestri', () => {
  const findings = scan();

  it('skaner haqiqatan ishlaydi (soxta yashil emas)', () => {
    // Prod'da 30+ maxsus fe'l va 100+ chaqiruv joyi bor.
    expect(findings.length).toBeGreaterThan(100);
    const verbs = new Set(findings.flatMap((f) => f.verbs));
    expect(verbs.size).toBeGreaterThan(40);
    // Enum, shart-ifoda, konstanta obyekt va shablon shakllari ham ko'rildi.
    for (const v of [
      'status_change', // ActivityAction.STATUS_CHANGE
      'unassign', // logistId ? ASSIGN : UNASSIGN
      'market.tg_token_rotated', // MARKET_TG_TOKEN_AUDIT_ACTION.ROTATED
      'auth.otp_requested', // `auth.${event}`
      'finance.manual_expense', // satr
    ]) {
      expect(verbs.has(v)).toBe(true);
    }
  });

  it('⭐ CI: kodda yozilayotgan HAR fe`l reyestrda bor; hal qilinmagan ifoda yo`q', () => {
    const unresolved = findings
      .filter((f) => f.unresolved)
      .map((f) => `${f.file}:${f.line} action=${f.unresolved}`);
    expect(unresolved).toEqual([]);
    const missing = [
      ...new Set(
        findings.flatMap((f) =>
          f.verbs
            .filter((v) => !ACTIVITY_ACTION_REGISTRY[v])
            .map((v) => `${v} (${f.file}:${f.line})`),
        ),
      ),
    ];
    expect(missing).toEqual([]);
  });

  it('⭐ CI test reyestrda yo`q fe`lni USHLAYDI (o`z-o`zini tekshirish)', () => {
    const sf = ts.createSourceFile(
      'x.ts',
      "this.activityLog.log({ entity_type: 'Order', entity_id: 1, action: 'order.brand_new_verb' });",
      ts.ScriptTarget.Latest,
      true,
    );
    let verb = '';
    const visit = (n: ts.Node) => {
      if (ts.isPropertyAssignment(n) && n.name.getText(sf) === 'action')
        verb = (n.initializer as ts.StringLiteral).text;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(verb).toBe('order.brand_new_verb');
    expect(ACTIVITY_ACTION_REGISTRY[verb]).toBeUndefined();
  });

  it('har `ActivityAction` qiymati reyestrda', () => {
    for (const v of Object.values(ActivityAction)) {
      expect(ACTIVITY_ACTION_REGISTRY[v]).toBeDefined();
    }
  });

  it('har yozuvda o`zbekcha yorliq, ma`lum kategoriya, ikona va ton', () => {
    const cats = new Set(ACTIVITY_ACTION_CATEGORIES.map((c) => c.key));
    for (const [action, info] of Object.entries(ACTIVITY_ACTION_REGISTRY)) {
      expect({ action, ok: info.label.length > 1 }).toEqual({
        action,
        ok: true,
      });
      expect(cats.has(info.category)).toBe(true);
      expect(info.icon).toMatch(/^[a-z-]+$/);
      expect(info.tone).toMatch(
        /^(green|red|rose|amber|blue|cyan|violet|slate)$/,
      );
    }
  });

  it('kartadagi kategoriyalar: Buyurtma / Moliya / Kirish / Filial / Integratsiya / Logistika', () => {
    const labels = ACTIVITY_ACTION_CATEGORIES.map((c) => c.label);
    for (const l of [
      'Buyurtma',
      'Moliya',
      'Kirish',
      'Filial',
      'Integratsiya',
      'Logistika',
    ]) {
      expect(labels).toContain(l);
    }
  });

  it('BeePost namunalari: sold/manual_expense ekvivalentlari', () => {
    expect(describeActivityAction('order.sell')).toMatchObject({
      label: 'Sotildi',
      tone: 'green',
      category: 'order',
      category_label: 'Buyurtma',
      known: true,
    });
    expect(describeActivityAction('finance.manual_expense')).toMatchObject({
      label: "Qo'lda chiqim",
      tone: 'rose',
      category: 'finance',
    });
  });

  it('⭐ reyestrda yo`q eski fe`l — humanize zaxirasi, UI sinmaydi', () => {
    expect(describeActivityAction('order.batch_sent')).toEqual({
      action: 'order.batch_sent',
      label: 'Order batch sent',
      category: 'order',
      category_label: 'Buyurtma',
      icon: 'dot',
      tone: 'slate',
      known: false,
    });
    expect(describeActivityAction('')).toMatchObject({
      label: '-',
      category: 'general',
    });
    expect(humanizeActivityAction('custody_changed')).toBe('Custody changed');
    expect(describeActivityAction(undefined as unknown as string).known).toBe(
      false,
    );
  });

  it('listActivityActions — kategoriya tartibida, takrorsiz', () => {
    const list = listActivityActions();
    expect(list).toHaveLength(Object.keys(ACTIVITY_ACTION_REGISTRY).length);
    expect(new Set(list.map((a) => a.action)).size).toBe(list.length);
    expect(list[0].category).toBe('order');
    expect(list[list.length - 1].category).toBe('general');
  });

  it('i6Nyedea: qisqa muddatli kirish fe`llari — login/logout/auth_failure (+OTP)', () => {
    expect(ACTIVITY_LOG_AUTH_ACTIONS).toEqual(
      expect.arrayContaining(['login', 'logout', 'auth_failure']),
    );
    expect(ACTIVITY_LOG_AUTH_ACTIONS).not.toContain('finance.manual_expense');
    expect(ACTIVITY_LOG_AUTH_ACTIONS).not.toContain('payment');
  });
});
