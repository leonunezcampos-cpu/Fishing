export const REQUIRED_GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

/** Escopos que NUNCA aceitamos: dariam exclusão permanente ou mexeriam nas configurações da conta. */
export const FORBIDDEN_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
];

export interface GoogleIdentityClaims {
  email?: unknown;
  email_verified?: unknown;
  sub?: unknown;
  hd?: unknown;
}

export type IdentityCheck =
  | { ok: true; email: string; sub: string }
  | { ok: false; reason: 'email_missing' | 'email_not_verified' | 'account_not_allowed' | 'missing_scope' | 'forbidden_scope' };

/**
 * Regra central de acesso: só a conta configurada passa.
 * Comparação exata (sem normalizar pontos ou "+alias"): o e-mail vem do id_token assinado pelo Google.
 */
export function checkGoogleIdentity(claims: GoogleIdentityClaims, grantedScope: string, allowedEmail: string): IdentityCheck {
  if (typeof claims.email !== 'string' || !claims.email || typeof claims.sub !== 'string') return { ok: false, reason: 'email_missing' };
  if (claims.email_verified !== true && claims.email_verified !== 'true') return { ok: false, reason: 'email_not_verified' };
  const email = claims.email.trim().toLowerCase();
  if (email !== allowedEmail.trim().toLowerCase()) return { ok: false, reason: 'account_not_allowed' };

  const scopes = new Set(grantedScope.split(/\s+/).filter(Boolean));
  if (FORBIDDEN_SCOPES.some(s => scopes.has(s))) return { ok: false, reason: 'forbidden_scope' };
  if (!scopes.has(REQUIRED_GMAIL_SCOPE)) return { ok: false, reason: 'missing_scope' };
  return { ok: true, email, sub: claims.sub };
}
