import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, deriveKey, encryptSecret, sha256, signPayload, verifySignedPayload } from '../src/crypto.js';

const key = randomBytes(32);
const AAD = 'leonunezcampos@gmail.com';

describe('criptografia do refresh token (AES-256-GCM)', () => {
  it('cifra e decifra (ida e volta)', () => {
    const s = encryptSecret('1//0g-refresh-token-çã', key, AAD);
    expect(decryptSecret(s, key, AAD)).toBe('1//0g-refresh-token-çã');
  });

  it('não guarda o texto claro e usa IV aleatório a cada vez', () => {
    const a = encryptSecret('segredo', key, AAD);
    const b = encryptSecret('segredo', key, AAD);
    expect(a.ciphertext).not.toContain('segredo');
    expect(Buffer.from(a.ciphertext, 'base64').toString()).not.toContain('segredo');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(Buffer.from(a.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(a.authTag, 'base64')).toHaveLength(16);
  });

  it('falha com chave errada', () => {
    const s = encryptSecret('segredo', key, AAD);
    expect(() => decryptSecret(s, randomBytes(32), AAD)).toThrow();
  });

  it('falha se o texto cifrado for adulterado', () => {
    const s = encryptSecret('segredo', key, AAD);
    const bytes = Buffer.from(s.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    expect(() => decryptSecret({ ...s, ciphertext: bytes.toString('base64') }, key, AAD)).toThrow();
  });

  it('falha se a tag de autenticação for adulterada', () => {
    const s = encryptSecret('segredo', key, AAD);
    const tag = Buffer.from(s.authTag, 'base64');
    tag[0] ^= 0x01;
    expect(() => decryptSecret({ ...s, authTag: tag.toString('base64') }, key, AAD)).toThrow();
  });

  it('falha se o segredo for movido para outra conta (AAD diferente)', () => {
    const s = encryptSecret('segredo', key, AAD);
    expect(() => decryptSecret(s, key, 'outra@gmail.com')).toThrow();
  });

  it('exige chave de 32 bytes', () => {
    expect(() => encryptSecret('x', randomBytes(16), AAD)).toThrow();
  });
});

describe('hash e links assinados', () => {
  it('sha256 é determinístico e não reversível trivialmente', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('link assinado: válido, adulterado, expirado', () => {
    const k = deriveKey(key, 'attachment-link-v1');
    const now = Date.now();
    const tok = signPayload({ m: 'msg', a: 'att', exp: Math.floor(now / 1000) + 60 }, k);
    expect(verifySignedPayload(tok, k, now)).toMatchObject({ m: 'msg', a: 'att' });
    expect(verifySignedPayload(tok.replace(/.$/, c => (c === 'A' ? 'B' : 'A')), k, now)).toBeNull();
    expect(verifySignedPayload(tok, deriveKey(key, 'outro-proposito'), now)).toBeNull();
    expect(verifySignedPayload(tok, k, now + 120_000)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ m: 'x', a: 'y', exp: 9e9 })).toString('base64url') + '.' + tok.split('.')[1];
    expect(verifySignedPayload(forged, k, now)).toBeNull();
  });
});
