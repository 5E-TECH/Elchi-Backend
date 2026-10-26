import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  RequestMethod,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { ClientProxy } from '@nestjs/microservices';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EventEmitter } from 'node:events';
import { Observable, of, Subject, throwError } from 'rxjs';
import {
  AI_ASSISTANT_TOOL_ENDPOINTS,
  AI_ASSISTANT_TOOL_NAMES,
  AI_ASSISTANT_TOOL_ROLES,
  type AiAssistantAccessState,
} from '@app/common';
import { AiAssistantGatewayController } from './ai-assistant-gateway.controller';
import { AnalyticsGatewayController } from './analytics-gateway.controller';
import { BranchGatewayController } from './branch-gateway.controller';
import { FinanceGatewayController } from './finance-gateway.controller';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ROLES_KEY } from './auth/roles.decorator';
import { RolesGuard } from './auth/roles.guard';
import {
  AiAssistantAccessUpdateDto,
  AiAssistantMessageDto,
} from './dto/ai-assistant.dto';

/**
 * F7PWp6cK — `/ai/assistant/*`: rollar, ruxsat (403 SSE'dan OLDIN), SSE
 * uzatish, va har yordamchi tool'i mos API endpointidan KENG emasligi.
 */

const ALLOWED: AiAssistantAccessState = {
  allowed: true,
  reason: null,
  feature_enabled: true,
  daily_limit: 100,
  used_today: 3,
  remaining_today: 97,
  reset_at: '2026-10-27T00:00:00+05:00',
};

function handlerOf(name: keyof AiAssistantGatewayController) {
  return Object.getOwnPropertyDescriptor(
    AiAssistantGatewayController.prototype,
    name,
  )?.value as object;
}

function setup(
  replies: Record<string, () => Observable<unknown>>,
  identity?: () => Observable<unknown>,
) {
  const send = jest.fn((pattern: { cmd: string }) => {
    const r = replies[pattern.cmd];
    return r ? r() : of(null);
  });
  const idSend = jest.fn(() => (identity ? identity() : of(null)));
  const controller = new AiAssistantGatewayController(
    { send } as unknown as ClientProxy,
    { send: idSend } as unknown as ClientProxy,
  );
  return { controller, send, idSend };
}

function fakeRes() {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    writableEnded: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v;
    },
    flushHeaders: jest.fn(),
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  };
  return { res, chunks, headers };
}

function fakeReq(roles: string[] = ['superadmin'], sub = '1') {
  const em = new EventEmitter();
  return Object.assign(em, { user: { sub, roles } });
}

describe('AiAssistantGatewayController (F7PWp6cK)', () => {
  describe('marshrut va rollar', () => {
    it("controller '/ai/assistant' da, JwtAuthGuard + RolesGuard", () => {
      expect(
        Reflect.getMetadata(PATH_METADATA, AiAssistantGatewayController),
      ).toBe('ai/assistant');
      expect(
        Reflect.getMetadata(GUARDS_METADATA, AiAssistantGatewayController),
      ).toEqual([JwtAuthGuard, RolesGuard]);
    });

    it.each([
      ['postMessage', RequestMethod.POST, 'messages', ['superadmin', 'admin']],
      [
        'conversations',
        RequestMethod.GET,
        'conversations',
        ['superadmin', 'admin'],
      ],
      [
        'conversation',
        RequestMethod.GET,
        'conversations/:id',
        ['superadmin', 'admin'],
      ],
      ['me', RequestMethod.GET, 'access/me', ['superadmin', 'admin']],
      ['listAccess', RequestMethod.GET, 'access', ['superadmin']],
      ['updateAccess', RequestMethod.PATCH, 'access', ['superadmin']],
    ] as const)('%s → %s %s, rollar %j', (name, method, path, roles) => {
      const h = handlerOf(name);
      expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(method);
      expect(Reflect.getMetadata(PATH_METADATA, h)).toBe(path);
      expect(Reflect.getMetadata(ROLES_KEY, h)).toEqual(roles);
    });
  });

  describe('tool ruxsati ⊆ mos API endpoint rollari (yordamchi orqali ko‘proq o‘qib bo‘lmaydi)', () => {
    const controllers: Record<string, { prototype: object }> = {
      FinanceGatewayController,
      AnalyticsGatewayController,
      BranchGatewayController,
    };
    it.each(AI_ASSISTANT_TOOL_NAMES.map((n) => [n]))('%s', (tool) => {
      const toolRoles = AI_ASSISTANT_TOOL_ROLES[tool];
      expect(toolRoles.length).toBeGreaterThan(0);
      for (const r of toolRoles) expect(['superadmin', 'admin']).toContain(r);
      const endpoints = AI_ASSISTANT_TOOL_ENDPOINTS[tool];
      expect(endpoints.length).toBeGreaterThan(0);
      for (const ep of endpoints) {
        const ctrl = controllers[ep.controller];
        expect(ctrl).toBeDefined();
        const handler = Object.getOwnPropertyDescriptor(
          ctrl.prototype,
          ep.handler,
        )?.value as object | undefined;
        expect(handler).toBeDefined();
        const endpointRoles =
          (Reflect.getMetadata(ROLES_KEY, handler!) as string[] | undefined) ??
          (Reflect.getMetadata(ROLES_KEY, ctrl) as string[] | undefined) ??
          [];
        for (const r of toolRoles) {
          expect({
            route: ep.route,
            role: r,
            ok: endpointRoles.includes(r),
          }).toEqual({
            route: ep.route,
            role: r,
            ok: true,
          });
        }
      }
    });
  });

  describe('POST /ai/assistant/messages', () => {
    it.each([
      [
        { ...ALLOWED, allowed: false, reason: 'access_disabled' },
        ForbiddenException,
      ],
      [
        { ...ALLOWED, allowed: false, reason: 'role_forbidden' },
        ForbiddenException,
      ],
      [
        { ...ALLOWED, allowed: false, reason: 'feature_disabled' },
        ServiceUnavailableException,
      ],
      [
        { ...ALLOWED, allowed: false, reason: 'ai_disabled' },
        ServiceUnavailableException,
      ],
    ] as const)(
      'ruxsat holati %j → xato SSE ochilishidan OLDIN',
      async (state, Err) => {
        const { controller, send } = setup({
          'ai.assistant.access.check': () => of(state),
        });
        const { res, chunks } = fakeRes();
        await expect(
          controller.postMessage(
            { message: 'savol' } as AiAssistantMessageDto,
            fakeReq(['admin'], '25'),
            res as any,
          ),
        ).rejects.toBeInstanceOf(Err);
        expect(res.statusCode).toBe(0);
        expect(chunks).toHaveLength(0);
        expect(send).not.toHaveBeenCalledWith(
          { cmd: 'ai.assistant.message' },
          expect.anything(),
        );
      },
    );

    it('kunlik limit tugagan → 429', async () => {
      const { controller } = setup({
        'ai.assistant.access.check': () =>
          of({ ...ALLOWED, used_today: 100, remaining_today: 0 }),
      });
      const { res } = fakeRes();
      const err = await controller
        .postMessage(
          { message: 'x' } as AiAssistantMessageDto,
          fakeReq(),
          res as any,
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(429);
    });

    it('SSE: sarlavhalar, har hodisa `event:` + `data:`, oqim tugaganda res.end()', async () => {
      const stream = new Subject<unknown>();
      const { controller, send } = setup({
        'ai.assistant.access.check': () => of(ALLOWED),
        'ai.assistant.message': () => stream.asObservable(),
      });
      const { res, chunks, headers } = fakeRes();
      await controller.postMessage(
        {
          message: 'Kassada qancha?',
          conversation_id: '7',
        } as AiAssistantMessageDto,
        fakeReq(['superadmin'], '1'),
        res as any,
      );
      expect(res.statusCode).toBe(200);
      expect(headers['content-type']).toBe('text/event-stream; charset=utf-8');
      expect(headers['cache-control']).toBe('no-cache, no-transform');
      expect(send).toHaveBeenCalledWith(
        { cmd: 'ai.assistant.message' },
        expect.objectContaining({
          requester: { id: '1', roles: ['superadmin'], branch_id: null },
          conversation_id: '7',
          message: 'Kassada qancha?',
        }),
      );
      stream.next({ type: 'meta', conversation_id: '7', message_id: '70' });
      stream.next({ type: 'delta', step: 1, text: 'Salom' });
      stream.next({ type: 'done', answer: 'Salom', sources: [] });
      stream.complete();
      expect(chunks[0]).toBe(
        'event: meta\ndata: {"type":"meta","conversation_id":"7","message_id":"70"}\n\n',
      );
      expect(chunks[1].startsWith('event: delta\n')).toBe(true);
      expect(chunks[2].startsWith('event: done\n')).toBe(true);
      expect(res.writableEnded).toBe(true);
    });

    it('oqim xatosi → `event: error` va yopiladi', async () => {
      const { controller } = setup({
        'ai.assistant.access.check': () => of(ALLOWED),
        'ai.assistant.message': () => throwError(() => new Error('rmq down')),
      });
      const { res, chunks } = fakeRes();
      await controller.postMessage(
        { message: 'x' } as AiAssistantMessageDto,
        fakeReq(),
        res as any,
      );
      expect(chunks[0]).toContain('event: error');
      expect(chunks[0]).toContain('"code":"ai_error"');
      expect(res.writableEnded).toBe(true);
    });
  });

  describe('suhbatlar va ruxsatlar', () => {
    it('ruxsatsiz admin suhbatlarni ham ko‘ra olmaydi (403)', async () => {
      const { controller } = setup({
        'ai.assistant.access.check': () =>
          of({ ...ALLOWED, allowed: false, reason: 'access_disabled' }),
      });
      await expect(
        controller.conversations({}, fakeReq(['admin'], '25')),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('funksiya o‘chiq bo‘lsa ham tarix ochiq (faqat rol/ruxsat)', async () => {
      const { controller, send } = setup({
        'ai.assistant.access.check': () =>
          of({ ...ALLOWED, allowed: false, reason: 'feature_disabled' }),
        'ai.assistant.conversations': () => of({ items: [], total: 0 }),
      });
      await expect(
        controller.conversations({ limit: 5 }, fakeReq()),
      ).resolves.toMatchObject({
        statusCode: 200,
      });
      expect(send).toHaveBeenCalledWith(
        { cmd: 'ai.assistant.conversations' },
        expect.objectContaining({
          limit: 5,
          requester: expect.objectContaining({ id: '1' }),
        }),
      );
    });

    it('PATCH /access — faqat ADMIN rolli foydalanuvchiga', async () => {
      const market = setup({}, () => of({ data: { roles: ['market'] } }));
      await expect(
        market.controller.updateAccess(
          { user_id: '37', enabled: true } as AiAssistantAccessUpdateDto,
          fakeReq(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const missing = setup({}, () =>
        throwError(() => ({ statusCode: 404, message: 'not found' })),
      );
      await expect(
        missing.controller.updateAccess(
          { user_id: '999', enabled: true } as AiAssistantAccessUpdateDto,
          fakeReq(),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);

      const admin = setup(
        {
          'ai.assistant.access.update': () =>
            of({ user_id: '25', enabled: true }),
        },
        () => of({ data: { roles: ['admin'] } }),
      );
      await expect(
        admin.controller.updateAccess(
          {
            user_id: '25',
            enabled: true,
            daily_limit: 50,
          } as AiAssistantAccessUpdateDto,
          fakeReq(['superadmin'], '1'),
        ),
      ).resolves.toMatchObject({ statusCode: 200 });
      expect(admin.send).toHaveBeenCalledWith(
        { cmd: 'ai.assistant.access.update' },
        {
          requester: { id: '1', roles: ['superadmin'], branch_id: null },
          user_id: '25',
          enabled: true,
          daily_limit: 50,
        },
      );
    });
  });

  describe('DTO validatsiyasi', () => {
    it('xabar: bo‘sh/uzun — xato; conversation_id faqat raqam', async () => {
      const bad = [
        { message: '' },
        { message: 'x'.repeat(2001) },
        { message: 'ok', conversation_id: 'abc' },
      ];
      for (const b of bad) {
        const errors = await validate(
          plainToInstance(AiAssistantMessageDto, b),
        );
        expect(errors.length).toBeGreaterThan(0);
      }
      const good = await validate(
        plainToInstance(AiAssistantMessageDto, {
          message: ' savol ',
          conversation_id: '12',
        }),
      );
      expect(good).toHaveLength(0);
    });

    it('access: daily_limit null ruxsat, manfiy/kasr — xato', async () => {
      expect(
        await validate(
          plainToInstance(AiAssistantAccessUpdateDto, {
            user_id: '25',
            enabled: true,
            daily_limit: null,
          }),
        ),
      ).toHaveLength(0);
      for (const daily_limit of [-1, 1.5, 10001]) {
        const errors = await validate(
          plainToInstance(AiAssistantAccessUpdateDto, {
            user_id: '25',
            enabled: true,
            daily_limit,
          }),
        );
        expect(errors.length).toBeGreaterThan(0);
      }
    });
  });
});
