import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { EncryptedSecret } from '../crypto.js';

export interface PendingAuthorization {
  id: string; // = state enviado ao Google
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  claudeState?: string;
  resource?: string;
  scopes: string[];
  googleCodeVerifier: string;
  expiresAt: Date;
}

export interface AuthorizationCode {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  scopes: string[];
  expiresAt: Date;
  usedAt?: Date | null;
}

export interface IssuedToken {
  tokenHash: string;
  kind: 'access' | 'refresh';
  clientId: string;
  familyId: string;
  scopes: string[];
  resource?: string;
  expiresAt: Date;
  revokedAt?: Date | null;
  usedAt?: Date | null; // refresh já trocado (rotação)
}

export interface GoogleCredential {
  accountEmail: string;
  googleSub: string;
  secret: EncryptedSecret;
  scopes: string;
  updatedAt: Date;
}

export interface SendAuditEntry {
  id?: string;
  sentAt: Date;
  tool: string;
  status: 'pending' | 'sent' | 'failed';
  recipientCount: number;
  gmailMessageId?: string;
  threadId?: string;
}

export interface Store {
  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined>;
  saveClient(client: OAuthClientInformationFull): Promise<void>;

  savePending(p: PendingAuthorization): Promise<void>;
  /** Lê e apaga (uso único). */
  takePending(id: string): Promise<PendingAuthorization | undefined>;

  saveCode(c: AuthorizationCode): Promise<void>;
  getCode(codeHash: string): Promise<AuthorizationCode | undefined>;
  /** Marca como usado de forma atômica. Retorna false se já estava usado. */
  consumeCode(codeHash: string): Promise<boolean>;

  saveToken(t: IssuedToken): Promise<void>;
  getToken(tokenHash: string): Promise<IssuedToken | undefined>;
  /** Marca refresh como usado de forma atômica. Retorna false se já estava usado. */
  consumeRefreshToken(tokenHash: string): Promise<boolean>;
  revokeToken(tokenHash: string): Promise<void>;
  revokeFamily(familyId: string): Promise<void>;
  revokeAllTokens(): Promise<void>;

  getGoogleCredential(email: string): Promise<GoogleCredential | undefined>;
  saveGoogleCredential(c: GoogleCredential): Promise<void>;
  deleteGoogleCredential(email: string): Promise<void>;

  /** Insere registro de auditoria e retorna o id. */
  insertSendAudit(e: SendAuditEntry): Promise<string>;
  updateSendAudit(id: string, patch: Partial<SendAuditEntry>): Promise<void>;
  /** Conta envios (pending + sent) desde `since`. */
  countSendsSince(since: Date): Promise<number>;

  cleanupExpired(now?: Date): Promise<void>;
}
