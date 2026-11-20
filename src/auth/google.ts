import { createRemoteJWKSet, jwtVerify } from 'jose';
import { GOOGLE_SCOPES } from '../config.js';
import type { GoogleIdentityClaims } from './allowedAccount.js';

export interface GoogleCodeExchange {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  scope: string;
  claims: GoogleIdentityClaims;
}

export interface GoogleOAuth {
  buildAuthUrl(state: string, codeChallenge: string): string;
  exchangeCode(code: string, codeVerifier: string): Promise<GoogleCodeExchange>;
  /** Retorna access token novo. Lança GoogleInvalidGrantError se o refresh token morreu. */
  refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; expiresIn: number }>;
  revoke(token: string): Promise<void>;
}

export class GoogleInvalidGrantError extends Error {
  constructor() {
    super('google_invalid_grant');
  }
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export class RealGoogleOAuth implements GoogleOAuth {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private redirectUri: string,
    private loginHint: string,
  ) {}

  buildAuthUrl(state: string, codeChallenge: string) {
    const u = new URL(AUTH_URL);
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('redirect_uri', this.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('include_granted_scopes', 'false');
    u.searchParams.set('login_hint', this.loginHint);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return u.toString();
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<GoogleCodeExchange> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        code_verifier: codeVerifier,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(`google_token_exchange_failed:${res.status}:${body?.error ?? ''}`);
    const { payload } = await jwtVerify(body.id_token, JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: this.clientId,
    });
    return {
      accessToken: body.access_token,
      expiresIn: body.expires_in,
      refreshToken: body.refresh_token,
      scope: body.scope ?? '',
      claims: payload as GoogleIdentityClaims,
    };
  }

  async refreshAccessToken(refreshToken: string) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
      }),
    });
    const body = (await res.json()) as any;
    if (!res.ok) {
      if (body?.error === 'invalid_grant') throw new GoogleInvalidGrantError();
      throw new Error(`google_refresh_failed:${res.status}`);
    }
    return { accessToken: body.access_token as string, expiresIn: body.expires_in as number };
  }

  async revoke(token: string) {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    }).catch(() => undefined);
  }
}

/**
 * SOMENTE DESENVOLVIMENTO (DEV_FAKE_GOOGLE=1): simula o Google.
 * O "código" é `fake:<email>`; permite testar o fluxo inteiro, inclusive conta recusada.
 */
export class FakeGoogleOAuth implements GoogleOAuth {
  constructor(private redirectUri: string, private defaultEmail: string) {}
  buildAuthUrl(state: string) {
    const u = new URL(this.redirectUri);
    u.searchParams.set('code', `fake:${this.defaultEmail}`);
    u.searchParams.set('state', state);
    return u.toString();
  }
  async exchangeCode(code: string) {
    const email = code.startsWith('fake:') ? code.slice(5) : 'desconhecido@example.com';
    return {
      accessToken: 'fake-google-access',
      expiresIn: 3600,
      refreshToken: 'fake-google-refresh',
      scope: GOOGLE_SCOPES.map(s => (s === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : s)).join(' '),
      claims: { email, email_verified: true, sub: `sub-${email}` },
    };
  }
  async refreshAccessToken() {
    return { accessToken: 'fake-google-access', expiresIn: 3600 };
  }
  async revoke() {}
}

/** Usado enquanto GOOGLE_CLIENT_ID/SECRET não foram configurados: o servidor sobe, mas não autoriza. */
export class UnconfiguredGoogleOAuth implements GoogleOAuth {
  private fail(): never {
    throw new Error('google_not_configured');
  }
  buildAuthUrl(): string {
    return this.fail();
  }
  async exchangeCode(): Promise<GoogleCodeExchange> {
    return this.fail();
  }
  async refreshAccessToken(): Promise<{ accessToken: string; expiresIn: number }> {
    return this.fail();
  }
  async revoke() {}
}
