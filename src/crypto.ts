import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export interface EncryptedSecret {
  ciphertext: string; // base64
  iv: string; // base64 (12 bytes)
  authTag: string; // base64 (16 bytes)
  keyVersion: number;
}

/** AES-256-GCM. `aad` amarra o segredo ao contexto (ex.: e-mail da conta). */
export function encryptSecret(plaintext: string, key: Buffer, aad: string, keyVersion = 1): EncryptedSecret {
  if (key.length !== 32) throw new Error('chave deve ter 32 bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion,
  };
}

export function decryptSecret(secret: EncryptedSecret, key: Buffer, aad: string): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(secret.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(secret.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function randomToken(prefix = '', bytes = 32): string {
  return prefix + randomBytes(bytes).toString('base64url');
}

/** Deriva subchaves independentes da chave mestra (ex.: para assinar links). */
export function deriveKey(master: Buffer, purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), purpose, 32));
}

/** Token assinado (HMAC-SHA256) com expiração: base64url(payload).base64url(mac) */
export function signPayload(payload: Record<string, unknown>, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifySignedPayload<T extends { exp: number }>(token: string, key: Buffer, nowMs = Date.now()): T | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', key).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}
