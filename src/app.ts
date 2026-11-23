import express, { type Request, type Response } from 'express';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import { deriveKey, sha256, verifySignedPayload } from './crypto.js';
import { log } from './logger.js';
import type { Store } from './store/types.js';
import { GmailOAuthProvider, MCP_SCOPE, sendPage } from './auth/provider.js';
import type { GoogleOAuth } from './auth/google.js';
import { GoogleTokenSource } from './auth/googleTokens.js';
import { GmailGateway, type FetchLike } from './gmail/gateway.js';
import { SendGuard } from './gmail/limits.js';
import { GmailService } from './gmail/service.js';
import { buildMcpServer } from './tools/index.js';
import { homePage, privacyPage } from './pages.js';

export interface AppDeps {
  config: Config;
  store: Store;
  google: GoogleOAuth;
  /** Injeção para testes/mocks: fetch usado pelo gateway do Gmail. */
  gmailFetch?: FetchLike;
}

export function createApp({ config, store, google, gmailFetch }: AppDeps) {
  const app = express();
  app.set('trust proxy', 1); // Railway fica atrás de um proxy
  app.disable('x-powered-by');

  // Log de acesso só com metadados (sem query string, que pode conter códigos/tokens).
  app.use((req, res, next) => {
    const t0 = performance.now();
    res.on('finish', () => {
      if (req.path === '/healthz') return;
      log.info({ event: 'http', method: req.method, path: req.path, httpStatus: res.statusCode, durationMs: Math.round(performance.now() - t0) });
    });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const provider = new GmailOAuthProvider(store, google, config);
  const tokens = new GoogleTokenSource(store, google, config.allowedEmail, config.encryptionKey);
  const gateway = new GmailGateway(() => tokens.getAccessToken(), gmailFetch, () => tokens.invalidate());
  const guard = new SendGuard(store, {
    dailyLimit: config.SEND_DAILY_LIMIT,
    maxRecipients: config.SEND_MAX_RECIPIENTS,
    timeZone: config.SEND_TIMEZONE,
  });
  const service = new GmailService(gateway, guard, {
    selfEmail: config.allowedEmail,
    senderName: config.SENDER_NAME,
    signature: config.signatureText || config.signatureHtml ? { text: config.signatureText, html: config.signatureHtml } : undefined,
  });
  const linkKey = deriveKey(config.encryptionKey, 'attachment-link-v1');

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/', (_req, res) => {
    res.type('html').send(homePage(config.allowedEmail));
  });
  app.get(['/privacidade', '/privacy'], (_req, res) => {
    res.type('html').send(privacyPage(config.allowedEmail));
  });

  // ── Servidor de autorização (para o Claude) ──
  const mcpUrl = new URL(config.mcpUrl);
  const issuerUrl = new URL(config.baseUrl);
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl: mcpUrl,
      scopesSupported: [MCP_SCOPE],
      resourceName: 'Gmail pessoal',
    }),
  );
  // Também na raiz (o claude.ai tenta /.well-known/oauth-protected-resource/<caminho> e depois a raiz).
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: mcpUrl.href,
      authorization_servers: [issuerUrl.href],
      scopes_supported: [MCP_SCOPE],
      resource_name: 'Gmail pessoal',
    });
  });

  const callbackLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
  app.get('/oauth/google/callback', callbackLimiter, (req, res, next) => {
    provider.handleGoogleCallback(req, res).catch(next);
  });

  // ── Endpoint MCP (Streamable HTTP, sem estado) ──
  const mcpLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: config.MCP_RATE_LIMIT_PER_MINUTE,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: req => (req.headers.authorization ? sha256(req.headers.authorization) : ipKeyGenerator(req.ip ?? '')),
  });
  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });
  const toolDeps = {
    service,
    baseUrl: config.baseUrl,
    linkKey,
    inlineMaxBytes: config.ATTACHMENT_INLINE_MAX_BYTES,
    attachmentMaxBytes: config.ATTACHMENT_MAX_BYTES,
    linkTtlSeconds: config.DOWNLOAD_LINK_TTL_SECONDS,
    dailyLimit: config.SEND_DAILY_LIMIT,
    maxRecipients: config.SEND_MAX_RECIPIENTS,
  };

  app.post('/mcp', mcpLimiter, bearer, express.json({ limit: '40mb' }), async (req: Request, res: Response) => {
    const server = buildMcpServer(toolDeps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      log.error({ event: 'mcp_request', status: 'error' });
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Erro interno' }, id: null });
    }
  });
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Método não permitido.' }, id: null });
  };
  app.get('/mcp', mcpLimiter, bearer, notAllowed);
  app.delete('/mcp', mcpLimiter, bearer, notAllowed);

  // ── Link temporário de anexos grandes (assinado com HMAC, expira) ──
  const downloadLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
  app.get('/attachments/download', downloadLimiter, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const t = typeof req.query.t === 'string' ? req.query.t : '';
    const p = verifySignedPayload<{ m: string; a: string; exp: number }>(t, linkKey);
    if (!p) return sendPage(res, 410, 'Link expirado', 'Este link de anexo expirou ou é inválido. Peça ao Claude para gerar outro.');
    try {
      const att = await service.getAttachment(p.m, p.a, config.ATTACHMENT_MAX_BYTES);
      res.setHeader('Content-Type', att.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(att.filename)}`);
      res.send(att.content);
    } catch {
      log.warn({ event: 'attachment_link', status: 'error' });
      sendPage(res, 404, 'Anexo indisponível', 'Não foi possível obter este anexo.');
    }
  });

  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    log.error({ event: 'unhandled', errorCode: err instanceof Error ? err.name : 'unknown' });
    if (!res.headersSent) res.status(500).json({ error: 'server_error' });
  });

  return { app, provider, service };
}
