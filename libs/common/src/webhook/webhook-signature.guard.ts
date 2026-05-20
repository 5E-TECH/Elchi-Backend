import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { verifyHmacSignature, HmacAlgorithm } from './hmac';

export interface WebhookSecretResolver {
  /**
   * Return the current (and optionally previous, for rotation) shared
   * secret(s) for this request. Throws / returns null when the partner
   * is unknown — the guard will then 401.
   *
   * Receives the raw express request so the resolver can look up the
   * integration by URL param, header (e.g. `x-partner-id`), or hostname.
   */
  resolve(req: Request): Promise<WebhookSecret | null> | WebhookSecret | null;
}

export interface WebhookSecret {
  current: string;
  previous?: string | null;
  /** Header name carrying the signature, default 'x-signature'. */
  signatureHeader?: string;
  /** Optional prefix to strip from the signature value, e.g. 'sha256='. */
  signaturePrefix?: string;
  /** Defaults to sha256. */
  algorithm?: HmacAlgorithm;
}

/**
 * NestJS guard that authenticates an incoming webhook by HMAC.
 *
 * Usage:
 *   1. Subclass and implement `resolveSecret(req)` to return the partner's
 *      current (and optional previous) shared secret.
 *   2. Annotate the controller method with `@UseGuards(YourGuard)`.
 *   3. Enable raw-body parsing on the Nest app via
 *      `NestFactory.create(..., { rawBody: true })` so `req.rawBody` is set.
 *
 * If the signature is missing, malformed, or fails verification the guard
 * throws Unauthorized — never reveal *why* it failed to the partner; a
 * structured log line carries the reason for the on-call operator.
 */
@Injectable()
export abstract class WebhookSignatureGuard implements CanActivate {
  private readonly logger = new Logger(this.constructor.name);

  abstract resolveSecret(
    req: Request,
  ): Promise<WebhookSecret | null> | WebhookSecret | null;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { rawBody?: Buffer }>();

    if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
      this.logger.warn(
        'Webhook request has no rawBody — did you forget `rawBody: true` on NestFactory.create?',
      );
      throw new UnauthorizedException();
    }

    const cfg = await this.resolveSecret(req);
    if (!cfg) {
      this.logger.warn(
        { path: req.originalUrl },
        'No webhook secret configured for inbound request',
      );
      throw new UnauthorizedException();
    }

    const headerName = (cfg.signatureHeader ?? 'x-signature').toLowerCase();
    const rawHeader = req.headers[headerName];
    const signature = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

    const result = verifyHmacSignature({
      rawBody: req.rawBody,
      signature: signature ?? '',
      secret: cfg.current,
      previousSecret: cfg.previous ?? null,
      stripPrefix: cfg.signaturePrefix,
      algorithm: cfg.algorithm,
    });

    if (!result.valid) {
      this.logger.warn(
        {
          path: req.originalUrl,
          reason: result.reason,
          ip: req.ip,
        },
        'Webhook HMAC verification failed',
      );
      throw new UnauthorizedException();
    }

    if (result.matchedSecret === 'previous') {
      // Surface rotation progress to operators without breaking traffic.
      this.logger.warn(
        { path: req.originalUrl },
        'Webhook authenticated with PREVIOUS secret — partner has not rotated yet',
      );
    }

    return true;
  }
}
