import { randomUUID } from 'node:crypto';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthorizationCode, GoogleCredential, IssuedToken, PendingAuthorization, SendAuditEntry, Store } from './types.js';

/** Implementação em memória: testes e desenvolvimento local. */
export class MemoryStore implements Store {
  clients = new Map<string, OAuthClientInformationFull>();
  pending = new Map<string, PendingAuthorization>();
  codes = new Map<string, AuthorizationCode>();
  tokens = new Map<string, IssuedToken>();
  google = new Map<string, GoogleCredential>();
  audit = new Map<string, SendAuditEntry>();

  async getClient(id: string) { return this.clients.get(id); }
  async saveClient(c: OAuthClientInformationFull) { this.clients.set(c.client_id, c); }

  async savePending(p: PendingAuthorization) { this.pending.set(p.id, p); }
  async takePending(id: string) {
    const p = this.pending.get(id);
    this.pending.delete(id);
    return p;
  }

  async saveCode(c: AuthorizationCode) { this.codes.set(c.codeHash, { ...c, usedAt: null }); }
  async getCode(h: string) { return this.codes.get(h); }
  async consumeCode(h: string) {
    const c = this.codes.get(h);
    if (!c || c.usedAt) return false;
    c.usedAt = new Date();
    return true;
  }

  async saveToken(t: IssuedToken) { this.tokens.set(t.tokenHash, { ...t, revokedAt: null, usedAt: null }); }
  async getToken(h: string) { return this.tokens.get(h); }
  async consumeRefreshToken(h: string) {
    const t = this.tokens.get(h);
    if (!t || t.usedAt) return false;
    t.usedAt = new Date();
    return true;
  }
  async revokeToken(h: string) {
    const t = this.tokens.get(h);
    if (t && !t.revokedAt) t.revokedAt = new Date();
  }
  async revokeFamily(familyId: string) {
    for (const t of this.tokens.values()) if (t.familyId === familyId && !t.revokedAt) t.revokedAt = new Date();
  }
  async revokeAllTokens() {
    for (const t of this.tokens.values()) if (!t.revokedAt) t.revokedAt = new Date();
  }

  async getGoogleCredential(email: string) { return this.google.get(email); }
  async saveGoogleCredential(c: GoogleCredential) { this.google.set(c.accountEmail, c); }
  async deleteGoogleCredential(email: string) { this.google.delete(email); }

  async insertSendAudit(e: SendAuditEntry) {
    const id = randomUUID();
    this.audit.set(id, { ...e, id });
    return id;
  }
  async updateSendAudit(id: string, patch: Partial<SendAuditEntry>) {
    const e = this.audit.get(id);
    if (e) Object.assign(e, patch);
  }
  async countSendsSince(since: Date) {
    let n = 0;
    for (const e of this.audit.values()) if (e.status !== 'failed' && e.sentAt >= since) n++;
    return n;
  }

  async cleanupExpired(now = new Date()) {
    for (const [k, p] of this.pending) if (p.expiresAt < now) this.pending.delete(k);
    for (const [k, c] of this.codes) if (c.expiresAt < now) this.codes.delete(k);
    for (const [k, t] of this.tokens) if (t.expiresAt < now) this.tokens.delete(k);
  }
}
