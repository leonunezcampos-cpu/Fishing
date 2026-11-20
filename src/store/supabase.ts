import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthorizationCode, GoogleCredential, IssuedToken, PendingAuthorization, SendAuditEntry, Store } from './types.js';

const SCHEMA = 'gmail_mcp';

function check<T>(r: { data: T; error: { message: string; code?: string } | null }, op: string): T {
  if (r.error) throw new Error(`Supabase ${op}: ${r.error.code ?? ''} ${r.error.message}`);
  return r.data;
}
const d = (v: string | null | undefined) => (v ? new Date(v) : null);

/**
 * Persistência no Supabase (schema gmail_mcp). Usa a service role key, que ignora RLS;
 * as tabelas têm RLS ativado sem políticas, então as chaves anon/publishable não leem nada.
 */
export class SupabaseStore implements Store {
  private db: SupabaseClient<any, any, any>;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: SCHEMA },
    });
  }

  async getClient(clientId: string) {
    const data = check(await this.db.from('oauth_clients').select('metadata').eq('client_id', clientId).maybeSingle(), 'getClient');
    return (data?.metadata as OAuthClientInformationFull | undefined) ?? undefined;
  }
  async saveClient(c: OAuthClientInformationFull) {
    check(
      await this.db.from('oauth_clients').upsert({ client_id: c.client_id, client_name: c.client_name ?? null, redirect_uris: c.redirect_uris, metadata: c }),
      'saveClient',
    );
  }

  async savePending(p: PendingAuthorization) {
    check(
      await this.db.from('oauth_pending').insert({
        id: p.id,
        client_id: p.clientId,
        redirect_uri: p.redirectUri,
        code_challenge: p.codeChallenge,
        claude_state: p.claudeState ?? null,
        resource: p.resource ?? null,
        scopes: p.scopes,
        google_code_verifier: p.googleCodeVerifier,
        expires_at: p.expiresAt.toISOString(),
      }),
      'savePending',
    );
  }
  async takePending(id: string) {
    const rows = check(await this.db.from('oauth_pending').delete().eq('id', id).select(), 'takePending') as any[];
    const r = rows?.[0];
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
    check(
      await this.db.from('oauth_codes').insert({
        code_hash: c.codeHash,
        client_id: c.clientId,
        redirect_uri: c.redirectUri,
        code_challenge: c.codeChallenge,
        resource: c.resource ?? null,
        scopes: c.scopes,
        expires_at: c.expiresAt.toISOString(),
      }),
      'saveCode',
    );
  }
  async getCode(h: string) {
    const r = check(await this.db.from('oauth_codes').select('*').eq('code_hash', h).maybeSingle(), 'getCode') as any;
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
    const rows = check(
      await this.db.from('oauth_codes').update({ used_at: new Date().toISOString() }).eq('code_hash', h).is('used_at', null).select('code_hash'),
      'consumeCode',
    ) as any[];
    return rows.length === 1;
  }

  async saveToken(t: IssuedToken) {
    check(
      await this.db.from('oauth_tokens').insert({
        token_hash: t.tokenHash,
        kind: t.kind,
        client_id: t.clientId,
        family_id: t.familyId,
        scopes: t.scopes,
        resource: t.resource ?? null,
        expires_at: t.expiresAt.toISOString(),
      }),
      'saveToken',
    );
  }
  async getToken(h: string) {
    const r = check(await this.db.from('oauth_tokens').select('*').eq('token_hash', h).maybeSingle(), 'getToken') as any;
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
    const rows = check(
      await this.db
        .from('oauth_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('token_hash', h)
        .eq('kind', 'refresh')
        .is('used_at', null)
        .select('token_hash'),
      'consumeRefreshToken',
    ) as any[];
    return rows.length === 1;
  }
  async revokeToken(h: string) {
    check(await this.db.from('oauth_tokens').update({ revoked_at: new Date().toISOString() }).eq('token_hash', h).is('revoked_at', null), 'revokeToken');
  }
  async revokeFamily(familyId: string) {
    check(
      await this.db.from('oauth_tokens').update({ revoked_at: new Date().toISOString() }).eq('family_id', familyId).is('revoked_at', null),
      'revokeFamily',
    );
  }
  async revokeAllTokens() {
    check(await this.db.from('oauth_tokens').update({ revoked_at: new Date().toISOString() }).is('revoked_at', null), 'revokeAllTokens');
  }

  async getGoogleCredential(email: string) {
    const r = check(await this.db.from('google_credentials').select('*').eq('account_email', email).maybeSingle(), 'getGoogleCredential') as any;
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
    check(
      await this.db.from('google_credentials').upsert({
        account_email: c.accountEmail,
        google_sub: c.googleSub,
        refresh_token_ciphertext: c.secret.ciphertext,
        iv: c.secret.iv,
        auth_tag: c.secret.authTag,
        key_version: c.secret.keyVersion,
        scopes: c.scopes,
        updated_at: c.updatedAt.toISOString(),
      }),
      'saveGoogleCredential',
    );
  }
  async deleteGoogleCredential(email: string) {
    check(await this.db.from('google_credentials').delete().eq('account_email', email), 'deleteGoogleCredential');
  }

  async insertSendAudit(e: SendAuditEntry) {
    const r = check(
      await this.db
        .from('send_audit')
        .insert({
          sent_at: e.sentAt.toISOString(),
          tool: e.tool,
          status: e.status,
          recipient_count: e.recipientCount,
          gmail_message_id: e.gmailMessageId ?? null,
          thread_id: e.threadId ?? null,
        })
        .select('id')
        .single(),
      'insertSendAudit',
    ) as any;
    return r.id as string;
  }
  async updateSendAudit(id: string, patch: Partial<SendAuditEntry>) {
    const row: Record<string, unknown> = {};
    if (patch.status) row.status = patch.status;
    if (patch.gmailMessageId) row.gmail_message_id = patch.gmailMessageId;
    if (patch.threadId) row.thread_id = patch.threadId;
    if (patch.recipientCount !== undefined) row.recipient_count = patch.recipientCount;
    check(await this.db.from('send_audit').update(row).eq('id', id), 'updateSendAudit');
  }
  async countSendsSince(since: Date) {
    const r = await this.db
      .from('send_audit')
      .select('id', { count: 'exact', head: true })
      .gte('sent_at', since.toISOString())
      .neq('status', 'failed');
    if (r.error) throw new Error(`Supabase countSendsSince: ${r.error.message}`);
    return r.count ?? 0;
  }

  async cleanupExpired(now = new Date()) {
    const iso = now.toISOString();
    check(await this.db.from('oauth_pending').delete().lt('expires_at', iso), 'cleanup pending');
    check(await this.db.from('oauth_codes').delete().lt('expires_at', iso), 'cleanup codes');
    check(await this.db.from('oauth_tokens').delete().lt('expires_at', iso), 'cleanup tokens');
  }
}
