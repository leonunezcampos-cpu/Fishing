import { describe, expect, it } from 'vitest';
import { checkGoogleIdentity, REQUIRED_GMAIL_SCOPE } from '../src/auth/allowedAccount.js';

const ALLOWED = 'leonunezcampos@gmail.com';
const SCOPE = `openid https://www.googleapis.com/auth/userinfo.email ${REQUIRED_GMAIL_SCOPE}`;
const claims = (over: Record<string, unknown> = {}) => ({ email: ALLOWED, email_verified: true, sub: '123', ...over });

describe('validação da conta permitida', () => {
  it('aceita a conta configurada com o escopo do Gmail', () => {
    expect(checkGoogleIdentity(claims(), SCOPE, ALLOWED)).toEqual({ ok: true, email: ALLOWED, sub: '123' });
  });

  it('ignora maiúsculas/minúsculas e espaços no e-mail', () => {
    expect(checkGoogleIdentity(claims({ email: ' LeoNunezCampos@Gmail.com ' }), SCOPE, ALLOWED).ok).toBe(true);
  });

  it.each([
    'outra.pessoa@gmail.com',
    'leonunezcampos@escritorio.com.br',
    'leonunezcampos+teste@gmail.com',
    'leo.nunezcampos@gmail.com',
    'leonunezcampos@gmail.com.evil.com',
    'xleonunezcampos@gmail.com',
  ])('recusa outra conta: %s', email => {
    expect(checkGoogleIdentity(claims({ email }), SCOPE, ALLOWED)).toEqual({ ok: false, reason: 'account_not_allowed' });
  });

  it('recusa e-mail não verificado', () => {
    expect(checkGoogleIdentity(claims({ email_verified: false }), SCOPE, ALLOWED)).toEqual({ ok: false, reason: 'email_not_verified' });
    expect(checkGoogleIdentity(claims({ email_verified: undefined }), SCOPE, ALLOWED).ok).toBe(false);
  });

  it('recusa quando falta e-mail ou sub', () => {
    expect(checkGoogleIdentity(claims({ email: undefined }), SCOPE, ALLOWED)).toEqual({ ok: false, reason: 'email_missing' });
    expect(checkGoogleIdentity(claims({ sub: undefined }), SCOPE, ALLOWED)).toEqual({ ok: false, reason: 'email_missing' });
  });

  it('recusa quando o usuário desmarcou o acesso ao Gmail', () => {
    expect(checkGoogleIdentity(claims(), 'openid email', ALLOWED)).toEqual({ ok: false, reason: 'missing_scope' });
  });

  it('recusa escopo amplo https://mail.google.com/ ou de configurações', () => {
    expect(checkGoogleIdentity(claims(), `${SCOPE} https://mail.google.com/`, ALLOWED)).toEqual({ ok: false, reason: 'forbidden_scope' });
    expect(checkGoogleIdentity(claims(), `${SCOPE} https://www.googleapis.com/auth/gmail.settings.sharing`, ALLOWED).ok).toBe(false);
  });
});
