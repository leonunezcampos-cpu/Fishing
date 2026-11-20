import { decryptSecret } from '../crypto.js';
import { log } from '../logger.js';
import type { Store } from '../store/types.js';
import { GoogleInvalidGrantError, type GoogleOAuth } from './google.js';

export class GoogleReauthRequiredError extends Error {
  constructor() {
    super('A autorização do Google expirou ou foi revogada. Desconecte e conecte novamente o conector no claude.ai.');
  }
}

/** Fornece access tokens do Google a partir do refresh token cifrado, com cache em memória. */
export class GoogleTokenSource {
  private cached?: { token: string; expiresAt: number };
  private inflight?: Promise<string>;

  constructor(
    private store: Store,
    private google: GoogleOAuth,
    private email: string,
    private key: Buffer,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > Date.now()) return this.cached.token;
    this.inflight ??= this.refresh().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  invalidate() {
    this.cached = undefined;
  }

  private async refresh(): Promise<string> {
    const cred = await this.store.getGoogleCredential(this.email);
    if (!cred) throw new GoogleReauthRequiredError();
    const refreshToken = decryptSecret(cred.secret, this.key, cred.accountEmail);
    try {
      const { accessToken, expiresIn } = await this.google.refreshAccessToken(refreshToken);
      this.cached = { token: accessToken, expiresAt: Date.now() + expiresIn * 1000 };
      return accessToken;
    } catch (e) {
      if (e instanceof GoogleInvalidGrantError) {
        // Refresh do Google morreu (revogado, senha trocada, app em "Testing" > 7 dias…).
        // Revogamos os tokens do Claude para forçar o claude.ai a refazer a autorização.
        log.warn({ event: 'google_refresh', status: 'invalid_grant' });
        await this.store.deleteGoogleCredential(this.email);
        await this.store.revokeAllTokens();
        throw new GoogleReauthRequiredError();
      }
      throw e;
    }
  }
}
