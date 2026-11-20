import pg from 'pg';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthorizationCode, GoogleCredential, IssuedToken, PendingAuthorization, SendAuditEntry, Store } from './types.js';

const d = (v: Date | string | null | undefined) => (v ? new Date(v) : null);

/**
 * Persistência em Postgres (schema gmail_mcp), conectando com um papel dedicado
 * (gmail_mcp_app) que só tem acesso a esse schema — não enxerga o resto do banco.
 */
export class PostgresStore implements Store {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      // Supabase exige TLS; o certificado do pooler é emitido pela CA própria do Supabase.
      ssl: { rejectUnauthorized: false },
    });
    this.pool.on('error', () => undefined);
  }

  private async q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool.query(sql, params);
    return r.rows as T[];
  }

  async ping() {
    await this.q('select 1 from gmail_mcp.oauth_clients limit 1');
  }

  async close() {
    await this.pool.end();
  }

  async getClient(clientId: string) {
    const [r] = await this.q('select metadata from gmail_mcp.oauth_clients where client_id = $1', [clientId]);
    return (r?.metadata as OAuthClientInformationFull | undefined) ?? undefined;
  }
  async saveClient(c: OAuthClientInformationFull) {
    await this.q(
      `insert into gmail_mcp.oauth_clients (client_id, client_name, redirect_uris, metadata) values ($1,$2,$3,$4)
       on conflict (client_id) do update set client_name = excluded.client_name, redirect_uris = excluded.redirect_uris, metadata = excluded.metadata`,
      [c.client_id, c.client_name ?? null, c.redirect_uris, JSON.stringify(c)],
    );
  }

  async savePending(p: PendingAuthorization) {
    await this.q(
      `insert into gmail_mcp.oauth_pending (id, client_id, redirect_uri, code_challenge, claude_state, resource, scopes, google_code_verifier, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [p.id, p.clientId, p.redirectUri, p.codeChallenge, p.claudeState ?? null, p.resource ?? null, p.scopes, p.googleCodeVerifier, p.expiresAt],
    );
  }
  async takePending(id: string) {
    const [r] = await this.q('delete from gmail_mcp.oauth_pending where id = $1 returning *', [id]);
    if (!r) return undefined;
    return {
      id: r.id,
      clientId: r.client_id,
      redirectUri: r.redirect_uri,
      codeChallenge: r.code_challenge,
      claudeState: r.claude_state ?? undefined,
      resource: r.resource ?? undefined,
      scopes: r.scopes ?? [],
      googleCodeVerifier: r.google_code_verifier,
      expiresAt: new Date(r.expires_at),
    } satisfies PendingAuthorization;
  }

  async saveCode(c: AuthorizationCode) {
    await this.q(
      `insert into gmail_mcp.oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, scopes, expires_at) values ($1,$2,$3,$4,$5,$6,$7)`,
      [c.codeHash, c.clientId, c.redirectUri, c.codeChallenge, c.resource ?? null, c.scopes, c.expiresAt],
    );
  }
  async getCode(h: string) {
    const [r] = await this.q('select * from gmail_mcp.oauth_codes where code_hash = $1', [h]);
    if (!r) return undefined;
    return {
      codeHash: r.code_hash,
      clientId: r.client_id,
      redirectUri: r.redirect_uri,
      codeChallenge: r.code_challenge,
      resource: r.resource ?? undefined,
      scopes: r.scopes ?? [],
      expiresAt: new Date(r.expires_at),
      usedAt: d(r.used_at),
    } satisfies AuthorizationCode;
  }
  async consumeCode(h: string) {
    const rows = await this.q('update gmail_mcp.oauth_codes set used_at = now() where code_hash = $1 and used_at is null returning code_hash', [h]);
    return rows.length === 1;
  }

  async saveToken(t: IssuedToken) {
    await this.q(
      `insert into gmail_mcp.oauth_tokens (token_hash, kind, client_id, family_id, scopes, resource, expires_at) values ($1,$2,$3,$4,$5,$6,$7)`,
      [t.tokenHash, t.kind, t.clientId, t.familyId, t.scopes, t.resource ?? null, t.expiresAt],
    );
  }
  async getToken(h: string) {
    const [r] = await this.q('select * from gmail_mcp.oauth_tokens where token_hash = $1', [h]);
    if (!r) return undefined;
    return {
      tokenHash: r.token_hash,
      kind: r.kind,
      clientId: r.client_id,
      familyId: r.family_id,
      scopes: r.scopes ?? [],
      resource: r.resource ?? undefined,
      expiresAt: new Date(r.expires_at),
      revokedAt: d(r.revoked_at),
      usedAt: d(r.used_at),
    } satisfies IssuedToken;
  }
  async consumeRefreshToken(h: string) {
    const rows = await this.q(
      `update gmail_mcp.oauth_tokens set used_at = now() where token_hash = $1 and kind = 'refresh' and used_at is null returning token_hash`,
      [h],
    );
    return rows.length === 1;
  }
  async revokeToken(h: string) {
    await this.q('update gmail_mcp.oauth_tokens set revoked_at = now() where token_hash = $1 and revoked_at is null', [h]);
  }
  async revokeFamily(familyId: string) {
    await this.q('update gmail_mcp.oauth_tokens set revoked_at = now() where family_id = $1 and revoked_at is null', [familyId]);
  }
  async revokeAllTokens() {
    await this.q('update gmail_mcp.oauth_tokens set revoked_at = now() where revoked_at is null');
  }

  async getGoogleCredential(email: string) {
    const [r] = await this.q('select * from gmail_mcp.google_credentials where account_email = $1', [email]);
    if (!r) return undefined;
    return {
      accountEmail: r.account_email,
      googleSub: r.google_sub,
      secret: { ciphertext: r.refresh_token_ciphertext, iv: r.iv, authTag: r.auth_tag, keyVersion: r.key_version },
      scopes: r.scopes,
      updatedAt: new Date(r.updated_at),
    } satisfies GoogleCredential;
  }
  async saveGoogleCredential(c: GoogleCredential) {
    await this.q(
      `insert into gmail_mcp.google_credentials (account_email, google_sub, refresh_token_ciphertext, iv, auth_tag, key_version, scopes, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (account_email) do update set google_sub = excluded.google_sub, refresh_token_ciphertext = excluded.refresh_token_ciphertext,
         iv = excluded.iv, auth_tag = excluded.auth_tag, key_version = excluded.key_version, scopes = excluded.scopes, updated_at = excluded.updated_at`,
      [c.accountEmail, c.googleSub, c.secret.ciphertext, c.secret.iv, c.secret.authTag, c.secret.keyVersion, c.scopes, c.updatedAt],
    );
  }
  async deleteGoogleCredential(email: string) {
    await this.q('delete from gmail_mcp.google_credentials where account_email = $1', [email]);
  }

  async insertSendAudit(e: SendAuditEntry) {
    const [r] = await this.q(
      `insert into gmail_mcp.send_audit (sent_at, tool, status, recipient_count, gmail_message_id, thread_id) values ($1,$2,$3,$4,$5,$6) returning id`,
      [e.sentAt, e.tool, e.status, e.recipientCount, e.gmailMessageId ?? null, e.threadId ?? null],
    );
    return r.id as string;
  }
  async updateSendAudit(id: string, patch: Partial<SendAuditEntry>) {
    await this.q(
      `update gmail_mcp.send_audit set status = coalesce($2, status), gmail_message_id = coalesce($3, gmail_message_id),
         thread_id = coalesce($4, thread_id), recipient_count = coalesce($5, recipient_count) where id = $1`,
      [id, patch.status ?? null, patch.gmailMessageId ?? null, patch.threadId ?? null, patch.recipientCount ?? null],
    );
  }
  async countSendsSince(since: Date) {
    const [r] = await this.q(`select count(*)::int as n from gmail_mcp.send_audit where sent_at >= $1 and status <> 'failed'`, [since]);
    return r.n as number;
  }

  async cleanupExpired(now = new Date()) {
    await this.q('delete from gmail_mcp.oauth_pending where expires_at < $1', [now]);
    await this.q('delete from gmail_mcp.oauth_codes where expires_at < $1', [now]);
    await this.q('delete from gmail_mcp.oauth_tokens where expires_at < $1', [now]);
  }
}
