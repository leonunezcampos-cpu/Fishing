import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { assertAllowed, ForbiddenGmailOperationError, GmailGateway } from '../src/gmail/gateway.js';
import { TOOL_NAMES } from '../src/tools/index.js';
import { GOOGLE_SCOPES } from '../src/config.js';

describe('bloqueio das ações proibidas no gateway do Gmail', () => {
  const forbidden: [string, string, boolean?][] = [
    ['POST', '/messages/abc123/trash'],
    ['POST', '/threads/abc123/trash'],
    ['POST', '/messages/abc123/untrash'],
    ['POST', '/threads/abc123/untrash'],
    ['DELETE', '/messages/abc123'],
    ['DELETE', '/threads/abc123'],
    ['DELETE', '/drafts/r123'],
    ['POST', '/messages/batchDelete'],
    ['POST', '/messages/batchModify'],
    ['POST', '/messages/import'],
    ['POST', '/messages'],
    ['POST', '/messages/import', true],
    ['POST', '/messages', true],
    ['POST', '/labels'],
    ['DELETE', '/labels/Label_1'],
    ['GET', '/settings/filters'],
    ['POST', '/settings/filters'],
    ['DELETE', '/settings/filters/f1'],
    ['PUT', '/settings/autoForwarding'],
    ['POST', '/settings/forwardingAddresses'],
    ['POST', '/settings/delegates'],
    ['PUT', '/settings/vacation'],
    ['PUT', '/settings/imap'],
    ['PUT', '/settings/pop'],
    ['POST', '/settings/sendAs'],
    ['POST', '/watch'],
    ['POST', '/stop'],
    ['GET', '/history'],
    // Tentativas de escapar da lista branca pelo ID
    ['GET', '/messages/abc/../../settings/filters'],
    ['POST', '/threads/abc%2Ftrash/modify'],
    ['GET', '/threads/abc?x=1'],
    ['GET', '/messages//trash'],
    ['POST', '/threads/abc/trash/modify'],
  ];

  it.each(forbidden)('recusa %s %s', (method, path, upload) => {
    expect(() => assertAllowed(method, path, !!upload)).toThrow(ForbiddenGmailOperationError);
  });

  it('recusa mover para TRASH/SPAM via modify (adicionar ou remover)', () => {
    for (const body of [{ addLabelIds: ['TRASH'] }, { addLabelIds: ['trash'] }, { removeLabelIds: ['TRASH'] }, { addLabelIds: ['SPAM'] }]) {
      expect(() => assertAllowed('POST', '/threads/abc/modify', false, body)).toThrow(ForbiddenGmailOperationError);
      expect(() => assertAllowed('POST', '/messages/abc/modify', false, body)).toThrow(ForbiddenGmailOperationError);
    }
    expect(() => assertAllowed('POST', '/threads/abc/modify', false, { removeLabelIds: ['INBOX'] })).not.toThrow();
  });

  it('a requisição proibida não chega à rede', async () => {
    const fetchSpy = vi.fn();
    const gw = new GmailGateway(async () => 'tok', fetchSpy as any);
    await expect(gw.request({ method: 'POST', path: '/messages/abc/trash' })).rejects.toBeInstanceOf(ForbiddenGmailOperationError);
    await expect(gw.request({ method: 'POST', path: '/threads/abc/modify', json: { addLabelIds: ['TRASH'] } })).rejects.toBeInstanceOf(
      ForbiddenGmailOperationError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('permite as operações necessárias', () => {
    const allowed: [string, string, boolean?][] = [
      ['GET', '/threads'],
      ['GET', '/threads/18c2f0a1b2'],
      ['POST', '/threads/18c2f0a1b2/modify'],
      ['GET', '/messages/18c2f0a1b2'],
      ['GET', '/messages/18c2/attachments/ANGjdJ-x_y'],
      ['GET', `/messages/18c2/attachments/ANGjdJ${'a-B_9'.repeat(90)}`],
      ['POST', '/messages/send'],
      ['POST', '/messages/send', true],
      ['GET', '/labels'],
      ['GET', '/drafts'],
      ['POST', '/drafts'],
      ['PUT', '/drafts/r-123'],
      ['POST', '/drafts/send'],
    ];
    for (const [m, p, u] of allowed) expect(() => assertAllowed(m, p, !!u)).not.toThrow();
  });
});

describe('superfície do servidor', () => {
  it('nenhuma ferramenta exposta exclui, manda para a lixeira ou mexe em configurações', () => {
    for (const name of TOOL_NAMES) expect(name).not.toMatch(/trash|delete|remove|purge|empty|filter|forward_auto|delegat|setting|spam/i);
  });

  it('não pede o escopo amplo https://mail.google.com/ nem escopos de configurações', () => {
    expect(GOOGLE_SCOPES).not.toContain('https://mail.google.com/');
    expect(GOOGLE_SCOPES.some(s => s.includes('settings'))).toBe(false);
  });

  it('nenhum arquivo de src/ (fora o gateway) chama trash/delete da Gmail API', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(join(import.meta.dirname, '..', 'src'));
    const offenders = files
      .filter(f => !f.endsWith(join('gmail', 'gateway.ts')))
      .filter(f => /\/(trash|untrash)\b|batchDelete|method:\s*['"]DELETE['"]|settings\/(filters|forwarding|delegates|autoForwarding)/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
