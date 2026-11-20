import type { Store } from '../store/types.js';

export class SendLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendLimitError';
  }
}

/** Início do dia corrente (00:00) no fuso indicado, como instante UTC. */
export function startOfDayInTimeZone(now: Date, timeZone: string): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(now)
      .map(p => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMs = asUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day) - offsetMs);
}

export interface SendLimitsConfig {
  dailyLimit: number;
  maxRecipients: number;
  timeZone: string;
}

/**
 * Controla os limites de envio. Reserva uma vaga (registro 'pending' na auditoria) ANTES de enviar,
 * para que envios simultâneos não estourem o limite diário.
 */
export class SendGuard {
  constructor(private store: Store, private cfg: SendLimitsConfig, private now: () => Date = () => new Date()) {}

  checkRecipients(count: number) {
    if (count === 0) throw new SendLimitError('A mensagem não tem nenhum destinatário.');
    if (count > this.cfg.maxRecipients) {
      throw new SendLimitError(
        `Envio recusado: ${count} destinatários excede o limite de ${this.cfg.maxRecipients} por mensagem (SEND_MAX_RECIPIENTS).`,
      );
    }
  }

  async reserve(tool: string, recipientCount: number): Promise<string> {
    this.checkRecipients(recipientCount);
    const since = startOfDayInTimeZone(this.now(), this.cfg.timeZone);
    const used = await this.store.countSendsSince(since);
    if (used >= this.cfg.dailyLimit) {
      throw new SendLimitError(
        `Envio recusado: limite diário de ${this.cfg.dailyLimit} envios atingido (SEND_DAILY_LIMIT). O contador zera à meia-noite (${this.cfg.timeZone}).`,
      );
    }
    const id = await this.store.insertSendAudit({ sentAt: this.now(), tool, status: 'pending', recipientCount });
    // Revalida após reservar (corrida entre dois envios simultâneos).
    const after = await this.store.countSendsSince(since);
    if (after > this.cfg.dailyLimit) {
      await this.store.updateSendAudit(id, { status: 'failed' });
      throw new SendLimitError(`Envio recusado: limite diário de ${this.cfg.dailyLimit} envios atingido (SEND_DAILY_LIMIT).`);
    }
    return id;
  }

  async complete(id: string, gmailMessageId: string, threadId: string, recipientCount: number) {
    await this.store.updateSendAudit(id, { status: 'sent', gmailMessageId, threadId, recipientCount });
  }

  async fail(id: string) {
    await this.store.updateSendAudit(id, { status: 'failed' });
  }
}
