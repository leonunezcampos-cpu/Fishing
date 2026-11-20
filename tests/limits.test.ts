import { describe, expect, it } from 'vitest';
import { SendGuard, SendLimitError, startOfDayInTimeZone } from '../src/gmail/limits.js';
import { MemoryStore } from '../src/store/memory.js';

const cfg = { dailyLimit: 3, maxRecipients: 2, timeZone: 'America/Sao_Paulo' };

describe('limites de envio', () => {
  it('recusa acima do máximo de destinatários e com zero destinatários', async () => {
    const g = new SendGuard(new MemoryStore(), cfg);
    await expect(g.reserve('send_message', 3)).rejects.toThrow(/3 destinatários excede o limite de 2/);
    await expect(g.reserve('send_message', 0)).rejects.toBeInstanceOf(SendLimitError);
    await expect(g.reserve('send_message', 2)).resolves.toBeTypeOf('string');
  });

  it('recusa após atingir o limite diário', async () => {
    const store = new MemoryStore();
    const g = new SendGuard(store, cfg);
    for (let i = 0; i < 3; i++) {
      const id = await g.reserve('send_message', 1);
      await g.complete(id, `m${i}`, `t${i}`, 1);
    }
    await expect(g.reserve('send_message', 1)).rejects.toThrow(/limite diário de 3/);
  });

  it('envios que falharam não contam', async () => {
    const store = new MemoryStore();
    const g = new SendGuard(store, cfg);
    for (let i = 0; i < 5; i++) await g.fail(await g.reserve('send_message', 1));
    await expect(g.reserve('send_message', 1)).resolves.toBeTypeOf('string');
  });

  it('envios de ontem (fuso de São Paulo) não contam', async () => {
    const store = new MemoryStore();
    // 23:30 de 19/11 em São Paulo = 02:30Z de 20/11
    let now = new Date('2026-11-20T02:30:00Z');
    const g = new SendGuard(store, cfg, () => now);
    for (let i = 0; i < 3; i++) await g.reserve('send_message', 1);
    await expect(g.reserve('send_message', 1)).rejects.toBeInstanceOf(SendLimitError);
    now = new Date('2026-11-20T03:00:01Z'); // 00:00:01 de 20/11 em SP
    await expect(g.reserve('send_message', 1)).resolves.toBeTypeOf('string');
  });

  it('auditoria guarda só metadados (sem endereços)', async () => {
    const store = new MemoryStore();
    const g = new SendGuard(store, cfg);
    const id = await g.reserve('reply', 2);
    await g.complete(id, 'msg-1', 'thr-1', 2);
    const e = store.audit.get(id)!;
    expect(Object.keys(e).sort()).toEqual(['gmailMessageId', 'id', 'recipientCount', 'sentAt', 'status', 'threadId', 'tool']);
    expect(e).toMatchObject({ status: 'sent', tool: 'reply', recipientCount: 2, gmailMessageId: 'msg-1' });
  });

  it('início do dia no fuso', () => {
    expect(startOfDayInTimeZone(new Date('2026-11-20T15:00:00Z'), 'America/Sao_Paulo').toISOString()).toBe('2026-11-20T03:00:00.000Z');
    expect(startOfDayInTimeZone(new Date('2026-11-20T02:00:00Z'), 'America/Sao_Paulo').toISOString()).toBe('2026-11-19T03:00:00.000Z');
    expect(startOfDayInTimeZone(new Date('2026-11-20T15:00:00Z'), 'UTC').toISOString()).toBe('2026-11-20T00:00:00.000Z');
  });
});
