import { describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import {
  applySignature,
  buildRawMessage,
  buildReplyEnvelope,
  countRecipients,
  ensurePrefix,
  validateRecipients,
} from '../src/gmail/mime.js';

const SELF = 'leonunezcampos@gmail.com';

describe('montagem MIME', () => {
  it('codifica acentos no assunto (RFC 2047) e no corpo (UTF-8)', async () => {
    const raw = await buildRawMessage({
      from: `"Léo Núñez" <${SELF}>`,
      to: ['José da Conceição <jose@example.com>'],
      subject: 'Ação: revisão do orçamento — março/2026 ✅',
      text: 'Olá, José!\nSegue a revisão: coração, pão, açúcar, ñandú.',
      html: '<p>Olá, <b>José</b>! Atenção às ações.</p>',
    });
    const head = raw.toString('latin1').split(/\r?\n\r?\n/)[0];
    // Cabeçalhos são 7 bits: nada de bytes não-ASCII crus
    expect(/[^\x00-\x7f]/.test(head)).toBe(false);
    expect(head).toMatch(/Subject: =\?UTF-8\?/i);

    const parsed = await simpleParser(raw);
    expect(parsed.subject).toBe('Ação: revisão do orçamento — março/2026 ✅');
    expect(parsed.text?.trim()).toBe('Olá, José!\nSegue a revisão: coração, pão, açúcar, ñandú.');
    expect(parsed.html).toContain('Atenção às ações');
    expect(parsed.from?.value[0]).toEqual({ address: SELF, name: 'Léo Núñez' });
    expect((parsed.to as any).value[0]).toEqual({ address: 'jose@example.com', name: 'José da Conceição' });
  });

  it('inclui anexos (inclusive binário e nome acentuado) com conteúdo íntegro', async () => {
    const bin = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const raw = await buildRawMessage({
      from: SELF,
      to: ['a@example.com'],
      subject: 'Anexos',
      text: 'corpo',
      attachments: [
        { filename: 'relatório final.pdf', mimeType: 'application/pdf', content: Buffer.from('%PDF-1.7 teste') },
        { filename: 'dados.bin', content: bin },
      ],
    });
    const parsed = await simpleParser(raw);
    expect(parsed.attachments).toHaveLength(2);
    expect(parsed.attachments[0].filename).toBe('relatório final.pdf');
    expect(parsed.attachments[0].contentType).toBe('application/pdf');
    expect(parsed.attachments[0].content.toString()).toBe('%PDF-1.7 teste');
    expect(Buffer.compare(parsed.attachments[1].content, bin)).toBe(0);
  });

  it('mantém o cabeçalho Bcc no raw (o Gmail o usa e remove antes de entregar)', async () => {
    const raw = await buildRawMessage({ from: SELF, to: ['a@example.com'], bcc: ['oculto@example.com'], subject: 's', text: 't' });
    const parsed = await simpleParser(raw);
    expect((parsed.bcc as any).value[0].address).toBe('oculto@example.com');
  });

  it('grava In-Reply-To e References', async () => {
    const raw = await buildRawMessage({
      from: SELF,
      to: ['a@example.com'],
      subject: 'Re: x',
      text: 't',
      inReplyTo: '<orig-1@example.com>',
      references: ['<root-0@example.com>', '<orig-1@example.com>'],
    });
    const parsed = await simpleParser(raw);
    expect(parsed.inReplyTo).toBe('<orig-1@example.com>');
    expect(parsed.references).toEqual(['<root-0@example.com>', '<orig-1@example.com>']);
  });

  it('não lê arquivos locais nem URLs como anexo', async () => {
    const raw = await buildRawMessage({
      from: SELF,
      to: ['a@example.com'],
      subject: 's',
      text: 't',
      attachments: [{ filename: 'passwd', content: Buffer.from('conteúdo legítimo') }],
    });
    expect(raw.toString()).not.toContain('root:x:0:0');
  });

  it('exige corpo', async () => {
    await expect(buildRawMessage({ from: SELF, to: ['a@example.com'], subject: 's' })).rejects.toThrow();
  });
});

describe('encadeamento de respostas', () => {
  const orig = {
    messageId: '<orig-1@example.com>',
    references: '<root-0@example.com> <mid-0@example.com>',
    subject: 'Reunião de amanhã',
    from: 'Maria <maria@example.com>',
    to: `${SELF}, joao@example.com`,
    cc: 'Ana <ana@example.com>, LEONUNEZCAMPOS@gmail.com',
  };

  it('responder: só ao remetente, com Re:, In-Reply-To e References corretos', () => {
    const r = buildReplyEnvelope(orig, SELF, false);
    expect(r.to).toEqual(['"Maria" <maria@example.com>']);
    expect(r.cc).toEqual([]);
    expect(r.subject).toBe('Re: Reunião de amanhã');
    expect(r.inReplyTo).toBe('<orig-1@example.com>');
    expect(r.references).toEqual(['<root-0@example.com>', '<mid-0@example.com>', '<orig-1@example.com>']);
  });

  it('responder a todos: inclui To/Cc originais e exclui o próprio endereço (qualquer caixa)', () => {
    const r = buildReplyEnvelope(orig, SELF, true);
    expect(r.to).toEqual(['"Maria" <maria@example.com>']);
    expect(r.cc).toEqual(['joao@example.com', '"Ana" <ana@example.com>']);
    expect(JSON.stringify(r).toLowerCase()).not.toContain(SELF);
  });

  it('usa Reply-To quando presente', () => {
    const r = buildReplyEnvelope({ ...orig, replyTo: 'lista@example.com' }, SELF, false);
    expect(r.to).toEqual(['lista@example.com']);
  });

  it('resposta a mensagem enviada por mim vai para os destinatários originais', () => {
    const r = buildReplyEnvelope({ ...orig, from: SELF, to: 'cliente@example.com', cc: 'socio@example.com' }, SELF, true);
    expect(r.to).toEqual(['cliente@example.com']);
    expect(r.cc).toEqual(['socio@example.com']);
  });

  it('não duplica Re: e não duplica Message-ID em References', () => {
    const r = buildReplyEnvelope({ ...orig, subject: 'RE: Reunião', references: '<orig-1@example.com>' }, SELF, false);
    expect(r.subject).toBe('RE: Reunião');
    expect(r.references).toEqual(['<orig-1@example.com>']);
  });

  it('sem References originais: References = Message-ID original', () => {
    const r = buildReplyEnvelope({ ...orig, references: undefined }, SELF, false);
    expect(r.references).toEqual(['<orig-1@example.com>']);
  });

  it('prefixos', () => {
    expect(ensurePrefix('Assunto', 'Fwd')).toBe('Fwd: Assunto');
    expect(ensurePrefix('Fwd: Assunto', 'Fwd')).toBe('Fwd: Assunto');
    expect(ensurePrefix('ENC: Assunto', 'Fwd')).toBe('ENC: Assunto');
    expect(ensurePrefix('Res: Assunto', 'Re')).toBe('Res: Assunto');
  });
});

describe('destinatários e assinatura', () => {
  it('conta destinatários únicos em to+cc+bcc', () => {
    expect(countRecipients({ to: ['a@x.com, B@x.com'], cc: ['b@x.com'], bcc: ['"C" <c@x.com>'] })).toBe(3);
  });

  it('rejeita endereços inválidos', () => {
    expect(() => validateRecipients(['não é email'], 'to')).toThrow();
    expect(() => validateRecipients(['a@x.com', 'b@'], 'to')).toThrow();
    expect(() => validateRecipients(['Fulano <a@x.com>'], 'to')).not.toThrow();
  });

  it('anexa assinatura em texto e HTML (com escape)', () => {
    const r = applySignature({ text: 'Oi', html: '<p>Oi</p>' }, { text: 'Léo\nAdvogado <OAB>' });
    expect(r.text).toBe('Oi\n\n-- \nLéo\nAdvogado <OAB>');
    expect(r.html).toBe('<p>Oi</p><br><br>-- <br>Léo<br>Advogado &lt;OAB&gt;');
    expect(applySignature({ text: 'Oi' }, undefined)).toEqual({ text: 'Oi' });
  });
});
