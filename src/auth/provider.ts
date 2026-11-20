import { randomUUID, createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { CLAUDE_REDIRECT_URI, type Config } from '../config.js';
import { encryptSecret, randomToken, sha256 } from '../crypto.js';
import { log } from '../logger.js';
import type { Store } from '../store/types.js';
import { checkGoogleIdentity } from './allowedAccount.js';
import type { GoogleOAuth } from './google.js';

export const MCP_SCOPE = 'gmail';
const PENDING_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;

function isLoopbackRedirect(uri: string) {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

function sameResource(a: string, b: string) {
  return a.replace(/\/$/, '') === b.replace(/\/$/, '');
}

export class GmailOAuthProvider implements OAuthServerProvider {
  constructor(
    private store: Store,
    private google: GoogleOAuth,
    private config: Pick<
      Config,
      'mcpUrl' | 'allowedEmail' | 'encryptionKey' | 'ACCESS_TOKEN_TTL_SECONDS' | 'REFRESH_TOKEN_TTL_SECONDS' | 'ALLOW_LOCALHOST_REDIRECTS'
    >,
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: id => this.store.getClient(id),
      registerClient: async client => {
        // Só aceitamos o callback do claude.ai (e loopback, se habilitado para o MCP Inspector).
        for (const uri of client.redirect_uris) {
          const ok = uri === CLAUDE_REDIRECT_URI || (this.config.ALLOW_LOCALHOST_REDIRECTS && isLoopbackRedirect(uri));
          if (!ok) throw new InvalidClientMetadataError('redirect_uri não permitido por este servidor');
        }
        const full = { ...client } as OAuthClientInformationFull;
        await this.store.saveClient(full);
        log.info({ event: 'client_registered', clientId: full.client_id });
        return full;
      },
    };
  }

  /** Perna 1 → Google: guarda o pedido do Claude e redireciona para o consentimento do Google. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    if (params.resource && !sameResource(params.resource.href, this.config.mcpUrl)) {
      throw new InvalidTargetError('resource não corresponde a este servidor MCP');
    }
    const id = randomToken('', 24);
    const googleVerifier = randomToken('', 48);
    const googleChallenge = createHash('sha256').update(googleVerifier).digest('base64url');
    await this.store.savePending({
      id,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      claudeState: params.state,
      resource: params.resource?.href,
      scopes: [MCP_SCOPE],
      googleCodeVerifier: googleVerifier,
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    });
    let url: string;
    try {
      url = this.google.buildAuthUrl(id, googleChallenge);
    } catch {
      sendPage(res, 503, 'Servidor ainda não configurado', 'As credenciais OAuth do Google ainda não foram configuradas neste servidor.');
      return;
    }
    res.redirect(302, url);
  }

  /** Perna 2 ← Google: valida a conta, guarda o refresh token cifrado e devolve o código ao Claude. */
  async handleGoogleCallback(req: Request, res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const pending = state ? await this.store.takePending(state) : undefined;
    if (!pending || pending.expiresAt < new Date()) {
      log.warn({ event: 'google_callback', status: 'invalid_state' });
      return sendPage(res, 400, 'Pedido expirado', 'O pedido de autorização expirou ou é inválido. Volte ao Claude e conecte novamente.');
    }
    const backToClaude = (params: Record<string, string>) => {
      const u = new URL(pending.redirectUri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (pending.claudeState) u.searchParams.set('state', pending.claudeState);
      return res.redirect(302, u.toString());
    };

    if (req.query.error || !code) {
      log.warn({ event: 'google_callback', status: 'denied' });
      return backToClaude({ error: 'access_denied', error_description: 'Autorização negada no Google' });
    }

    let exchange;
    try {
      exchange = await this.google.exchangeCode(code, pending.googleCodeVerifier);
    } catch (e) {
      log.error({ event: 'google_callback', status: 'exchange_failed', errorCode: (e as Error).message.split(':')[0] });
      return backToClaude({ error: 'server_error', error_description: 'Falha ao trocar o código com o Google' });
    }

    const check = checkGoogleIdentity(exchange.claims, exchange.scope, this.config.allowedEmail);
    if (!check.ok) {
      // Não guardamos nada da conta recusada e revogamos o que o Google acabou de emitir.
      await this.google.revoke(exchange.refreshToken ?? exchange.accessToken);
      log.warn({ event: 'google_callback', status: 'rejected', reason: check.reason });
      const msg =
        check.reason === 'account_not_allowed'
          ? 'Esta conta Google não está autorizada a usar este conector. Use a conta pessoal configurada no servidor.'
          : check.reason === 'missing_scope'
            ? 'Você precisa marcar a permissão de acesso ao Gmail na tela do Google. Conecte novamente e marque todas as caixas.'
            : 'Não foi possível validar a conta Google.';
      sendPage(res, 403, 'Acesso recusado', msg);
      return;
    }

    if (exchange.refreshToken) {
      await this.store.saveGoogleCredential({
        accountEmail: check.email,
        googleSub: check.sub,
        secret: encryptSecret(exchange.refreshToken, this.config.encryptionKey, check.email),
        scopes: exchange.scope,
        updatedAt: new Date(),
      });
    } else if (!(await this.store.getGoogleCredential(check.email))) {
      log.error({ event: 'google_callback', status: 'no_refresh_token' });
      return sendPage(
        res,
        400,
        'Sem refresh token',
        'O Google não devolveu um refresh token. Remova o acesso em myaccount.google.com/permissions e conecte de novo.',
      );
    }

    const authCode = randomToken('gmc_');
    await this.store.saveCode({
      codeHash: sha256(authCode),
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      resource: pending.resource,
      scopes: pending.scopes,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    log.info({ event: 'google_callback', status: 'ok', clientId: pending.clientId });
    return backToClaude({ code: authCode });
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string) {
    const c = await this.store.getCode(sha256(authorizationCode));
    if (!c || c.clientId !== client.client_id || c.usedAt || c.expiresAt < new Date()) {
      throw new InvalidGrantError('código de autorização inválido ou expirado');
    }
    return c.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const hash = sha256(authorizationCode);
    const c = await this.store.getCode(hash);
    if (!c || c.clientId !== client.client_id || c.expiresAt < new Date()) throw new InvalidGrantError('código inválido');
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError('redirect_uri diferente do usado na autorização');
    if (resource && c.resource && !sameResource(resource.href, c.resource)) throw new InvalidTargetError('resource diferente');
    if (!(await this.store.consumeCode(hash))) throw new InvalidGrantError('código já utilizado');
    return this.issueTokens(client.client_id, randomUUID(), c.scopes, c.resource ?? this.config.mcpUrl);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const hash = sha256(refreshToken);
    const t = await this.store.getToken(hash);
    if (!t || t.kind !== 'refresh' || t.clientId !== client.client_id) throw new InvalidGrantError('refresh token inválido');
    if (t.revokedAt || t.expiresAt < new Date()) throw new InvalidGrantError('refresh token expirado ou revogado');
    if (resource && t.resource && !sameResource(resource.href, t.resource)) throw new InvalidTargetError('resource diferente');
    if (!(await this.store.consumeRefreshToken(hash))) {
      // Reuso de refresh token já trocado: sinal de vazamento. Revoga a família inteira.
      await this.store.revokeFamily(t.familyId);
      log.warn({ event: 'refresh_reuse_detected', clientId: client.client_id });
      throw new InvalidGrantError('refresh token já utilizado');
    }
    return this.issueTokens(client.client_id, t.familyId, t.scopes, t.resource ?? this.config.mcpUrl);
  }

  private async issueTokens(clientId: string, familyId: string, scopes: string[], resource: string): Promise<OAuthTokens> {
    const access = randomToken('gma_');
    const refresh = randomToken('gmr_');
    const now = Date.now();
    await this.store.saveToken({
      tokenHash: sha256(access),
      kind: 'access',
      clientId,
      familyId,
      scopes,
      resource,
      expiresAt: new Date(now + this.config.ACCESS_TOKEN_TTL_SECONDS * 1000),
    });
    await this.store.saveToken({
      tokenHash: sha256(refresh),
      kind: 'refresh',
      clientId,
      familyId,
      scopes,
      resource,
      expiresAt: new Date(now + this.config.REFRESH_TOKEN_TTL_SECONDS * 1000),
    });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: this.config.ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const t = await this.store.getToken(sha256(token));
    if (!t || t.kind !== 'access' || t.revokedAt || t.expiresAt < new Date()) throw new InvalidTokenError('token inválido ou expirado');
    return {
      token,
      clientId: t.clientId,
      scopes: t.scopes,
      expiresAt: Math.floor(t.expiresAt.getTime() / 1000),
      resource: t.resource ? new URL(t.resource) : undefined,
    };
  }

  /** RFC 7009: revogar access ou refresh revoga a família inteira (a sessão do conector). */
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const t = await this.store.getToken(sha256(request.token));
    if (!t || t.clientId !== client.client_id) return;
    await this.store.revokeFamily(t.familyId);
    log.info({ event: 'token_revoked', clientId: client.client_id });
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function sendPage(res: Response, status: number, title: string, message: string) {
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(title)}</title><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem">` +
        `<h1 style="font-size:1.4rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`,
    );
}
