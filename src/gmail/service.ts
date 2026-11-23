import type { GmailGateway } from './gateway.js';
import { SendGuard } from './limits.js';
import {
  buildRawMessage,
  buildReplyEnvelope,
  countRecipients,
  ensurePrefix,
  applySignature,
  parseAddresses,
  validateRecipients,
  type OutgoingAttachment,
  type OutgoingMessage,
  type Signature,
} from './mime.js';
import { extractBody, header, listAttachments, summarizeMessage, type AttachmentInfo, type GmailMessage } from './parse.js';

/** Acima disso, usa o endpoint de upload multipart em vez de JSON com raw em base64. */
const RAW_JSON_MAX_BYTES = 4 * 1024 * 1024;
/** Limite do Gmail para a mensagem inteira (com anexos). */
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export type AttachmentInput =
  | { filename: string; mime_type?: string; content_base64: string }
  | { from_message_id: string; attachment_id: string; known?: AttachmentInfo };

export interface ComposeInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body_text?: string;
  body_html?: string;
  attachments?: AttachmentInput[];
  include_signature?: boolean;
}

export interface ReplyInput extends Omit<ComposeInput, 'subject' | 'to'> {
  message_id: string;
  reply_all?: boolean;
  /** Destinatários adicionais em "to" (além dos calculados). */
  to?: string[];
  include_quote?: boolean;
}

export interface ServiceConfig {
  selfEmail: string;
  senderName?: string;
  signature?: Signature;
}

export interface SendResult {
  messageId: string;
  threadId: string;
  recipients: { to: string[]; cc: string[]; bcc: string[] };
  recipientCount: number;
}

export class GmailService {
  constructor(
    private gw: GmailGateway,
    private guard: SendGuard,
    private cfg: ServiceConfig,
  ) {}

  private get from() {
    return this.cfg.senderName ? `${JSON.stringify(this.cfg.senderName)} <${this.cfg.selfEmail}>` : this.cfg.selfEmail;
  }

  // ───────────── Leitura ─────────────

  async searchThreads(query: string | undefined, pageToken: string | undefined, maxResults: number, includeSpamTrash: boolean) {
    const list = await this.gw.request<{ threads?: { id: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>({
      method: 'GET',
      path: '/threads',
      query: { q: query || undefined, pageToken, maxResults, includeSpamTrash },
    });
    const threads = await Promise.all(
      (list.threads ?? []).map(async t => {
        const th = await this.gw.request<{ id: string; messages?: GmailMessage[] }>({
          method: 'GET',
          path: `/threads/${t.id}`,
          query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date'] },
        });
        const msgs = th.messages ?? [];
        const first = msgs[0];
        const last = msgs[msgs.length - 1];
        const labels = new Set(msgs.flatMap(m => m.labelIds ?? []));
        return {
          threadId: th.id,
          subject: header(first?.payload, 'Subject'),
          lastFrom: header(last?.payload, 'From'),
          lastDate: header(last?.payload, 'Date'),
          messageCount: msgs.length,
          unread: labels.has('UNREAD'),
          labelIds: [...labels],
          snippet: last?.snippet,
        };
      }),
    );
    return { threads, nextPageToken: list.nextPageToken ?? null, resultSizeEstimate: list.resultSizeEstimate ?? threads.length };
  }

  async getThread(threadId: string, includeBodies: boolean, maxBodyChars: number) {
    const th = await this.gw.request<{ id: string; messages?: GmailMessage[] }>({ method: 'GET', path: `/threads/${threadId}`, query: { format: 'full' } });
    return {
      threadId: th.id,
      messageCount: th.messages?.length ?? 0,
      messages: (th.messages ?? []).map(m => summarizeMessage(m, { includeBody: includeBodies, maxBodyChars })),
    };
  }

  async getMessage(messageId: string, includeHtml: boolean) {
    const m = await this.gw.request<GmailMessage>({ method: 'GET', path: `/messages/${messageId}`, query: { format: 'full' } });
    const summary = summarizeMessage(m, { includeBody: true });
    const body = extractBody(m.payload);
    return {
      ...summary,
      messageIdHeader: header(m.payload, 'Message-ID'),
      replyTo: header(m.payload, 'Reply-To'),
      bcc: header(m.payload, 'Bcc'),
      ...(includeHtml && body.html ? { html: body.html } : {}),
    };
  }

  async listLabels() {
    const r = await this.gw.request<{ labels?: { id: string; name: string; type: string }[] }>({ method: 'GET', path: '/labels' });
    return (r.labels ?? []).map(l => ({ id: l.id, name: l.name, type: l.type })).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Metadados de um anexo. ATENÇÃO: o Gmail gera um attachmentId DIFERENTE a cada leitura da mensagem,
   * então um ID obtido antes (ex.: em get_message) normalmente não aparece numa nova leitura. Ele continua
   * válido para baixar o conteúdo; aqui só identificamos nome/tipo/tamanho:
   * 1) ID idêntico; 2) único anexo da mensagem; 3) tamanho igual (quando já baixado); 4) genérico.
   */
  private async resolveAttachmentInfo(messageId: string, attachmentId: string, downloadedSize?: number): Promise<AttachmentInfo | undefined> {
    const m = await this.gw.request<GmailMessage>({ method: 'GET', path: `/messages/${messageId}`, query: { format: 'full' } });
    const all = listAttachments(m.payload);
    const exact = all.find(a => a.attachmentId === attachmentId);
    if (exact) return { ...exact, attachmentId };
    if (all.length === 1) return { ...all[0], attachmentId };
    if (downloadedSize !== undefined) {
      const bySize = all.filter(a => a.size === downloadedSize);
      if (bySize.length === 1) return { ...bySize[0], attachmentId };
    }
    if (all.length === 0) throw new Error('Esta mensagem não tem anexos.');
    return undefined;
  }

  private async downloadAttachmentData(messageId: string, attachmentId: string) {
    const a = await this.gw.request<{ data: string; size: number }>({ method: 'GET', path: `/messages/${messageId}/attachments/${attachmentId}` });
    return Buffer.from(a.data, 'base64url');
  }

  /** Metadados do anexo (nome, tipo, tamanho) + conteúdo. */
  async getAttachment(messageId: string, attachmentId: string, maxBytes: number, known?: AttachmentInfo) {
    let info = known ?? (await this.resolveAttachmentInfo(messageId, attachmentId));
    if (info && info.size > maxBytes) throw new Error(`Anexo de ${info.size} bytes excede o limite de ${maxBytes} bytes.`);
    const content = await this.downloadAttachmentData(messageId, attachmentId);
    if (content.length > maxBytes) throw new Error(`Anexo de ${content.length} bytes excede o limite de ${maxBytes} bytes.`);
    info ??= (await this.resolveAttachmentInfo(messageId, attachmentId, content.length)) ?? {
      attachmentId,
      filename: 'anexo',
      mimeType: 'application/octet-stream',
      size: content.length,
    };
    return { ...info, size: content.length, content };
  }

  async getAttachmentInfo(messageId: string, attachmentId: string): Promise<AttachmentInfo> {
    const info = await this.resolveAttachmentInfo(messageId, attachmentId);
    if (info) return info;
    // Vários anexos e ID de outra leitura: baixa para descobrir pelo tamanho.
    const att = await this.getAttachment(messageId, attachmentId, Number.MAX_SAFE_INTEGER);
    return { attachmentId, filename: att.filename, mimeType: att.mimeType, size: att.size };
  }

  // ───────────── Organização ─────────────

  async resolveLabelIds(labels: string[]) {
    const all = await this.listLabels();
    return labels.map(l => {
      const hit = all.find(x => x.id === l) ?? all.find(x => x.name.toLowerCase() === l.toLowerCase());
      if (!hit) throw new Error(`Marcador não encontrado: "${l}". Use list_labels para ver os nomes disponíveis.`);
      return hit.id;
    });
  }

  async modifyThread(threadId: string, add: string[], remove: string[]) {
    const r = await this.gw.request<{ id: string; messages?: GmailMessage[] }>({
      method: 'POST',
      path: `/threads/${threadId}/modify`,
      json: { addLabelIds: add, removeLabelIds: remove },
    });
    return { threadId: r.id, ok: true };
  }

  async modifyMessage(messageId: string, add: string[], remove: string[]) {
    const r = await this.gw.request<GmailMessage>({
      method: 'POST',
      path: `/messages/${messageId}/modify`,
      json: { addLabelIds: add, removeLabelIds: remove },
    });
    return { messageId: r.id, threadId: r.threadId, labelIds: r.labelIds ?? [] };
  }

  // ───────────── Composição ─────────────

  private async resolveAttachments(list: AttachmentInput[] | undefined): Promise<OutgoingAttachment[]> {
    const out: OutgoingAttachment[] = [];
    for (const a of list ?? []) {
      if ('content_base64' in a) {
        out.push({ filename: a.filename, mimeType: a.mime_type, content: Buffer.from(a.content_base64, 'base64') });
      } else {
        const att = await this.getAttachment(a.from_message_id, a.attachment_id, MAX_MESSAGE_BYTES, a.known);
        out.push({ filename: att.filename, mimeType: att.mimeType, content: att.content });
      }
    }
    const total = out.reduce((n, a) => n + a.content.length, 0);
    if (total > MAX_MESSAGE_BYTES) throw new Error(`Anexos somam ${total} bytes; o Gmail aceita até ${MAX_MESSAGE_BYTES}.`);
    return out;
  }

  private body(input: { body_text?: string; body_html?: string; include_signature?: boolean }) {
    const body = { text: input.body_text, html: input.body_html };
    if (!body.text && !body.html) throw new Error('Informe body_text e/ou body_html.');
    return input.include_signature === false ? body : applySignature(body, this.cfg.signature);
  }

  private validate(m: Pick<OutgoingMessage, 'to' | 'cc' | 'bcc'>) {
    validateRecipients(m.to, 'to');
    validateRecipients(m.cc, 'cc');
    validateRecipients(m.bcc, 'bcc');
  }

  async composeNew(input: ComposeInput): Promise<{ message: OutgoingMessage; threadId?: string }> {
    const message: OutgoingMessage = {
      from: this.from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject ?? '',
      ...this.body(input),
      attachments: await this.resolveAttachments(input.attachments),
    };
    this.validate(message);
    return { message };
  }

  async composeReply(input: ReplyInput): Promise<{ message: OutgoingMessage; threadId: string }> {
    const orig = await this.gw.request<GmailMessage>({ method: 'GET', path: `/messages/${input.message_id}`, query: { format: 'full' } });
    const p = orig.payload;
    const env = buildReplyEnvelope(
      {
        messageId: header(p, 'Message-ID'),
        references: header(p, 'References'),
        subject: header(p, 'Subject'),
        from: header(p, 'From'),
        replyTo: header(p, 'Reply-To'),
        to: header(p, 'To'),
        cc: header(p, 'Cc'),
      },
      this.cfg.selfEmail,
      !!input.reply_all,
    );
    let body = this.body(input);
    if (input.include_quote !== false) {
      const origText = extractBody(p).text;
      const intro = `Em ${header(p, 'Date') ?? ''}, ${header(p, 'From') ?? ''} escreveu:`;
      const quoted = origText.split('\n').map(l => `> ${l}`).join('\n');
      body = {
        text: body.text !== undefined ? `${body.text}\n\n${intro}\n${quoted}` : undefined,
        html:
          body.html !== undefined
            ? `${body.html}<br><br><div>${escapeHtml(intro)}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${escapeHtml(origText).replace(/\n/g, '<br>')}</blockquote>`
            : undefined,
      };
    }
    const message: OutgoingMessage = {
      from: this.from,
      to: [...env.to, ...(input.to ?? [])],
      cc: [...env.cc, ...(input.cc ?? [])],
      bcc: input.bcc,
      subject: env.subject,
      ...body,
      inReplyTo: env.inReplyTo,
      references: env.references,
      attachments: await this.resolveAttachments(input.attachments),
    };
    this.validate(message);
    return { message, threadId: orig.threadId };
  }

  async composeForward(input: ComposeInput & { message_id: string; note?: string }) {
    const orig = await this.gw.request<GmailMessage>({ method: 'GET', path: `/messages/${input.message_id}`, query: { format: 'full' } });
    const p = orig.payload;
    const origBody = extractBody(p);
    const headerBlock = [
      '---------- Mensagem encaminhada ----------',
      `De: ${header(p, 'From') ?? ''}`,
      `Data: ${header(p, 'Date') ?? ''}`,
      `Assunto: ${header(p, 'Subject') ?? ''}`,
      `Para: ${header(p, 'To') ?? ''}`,
      ...(header(p, 'Cc') ? [`Cc: ${header(p, 'Cc')}`] : []),
    ];
    const note = input.note ?? input.body_text ?? '';
    const text = `${note}\n\n${headerBlock.join('\n')}\n\n${origBody.text}`;
    const html = origBody.html
      ? `<div>${escapeHtml(note).replace(/\n/g, '<br>')}</div><br><div>${headerBlock.map(escapeHtml).join('<br>')}</div><br>${origBody.html}`
      : undefined;
    const signed = input.include_signature === false ? { text, html } : applySignature({ text, html }, this.cfg.signature);

    // Anexos originais + eventuais anexos novos.
    // Usa os metadados desta mesma leitura (o attachmentId muda a cada leitura da mensagem).
    const originals = listAttachments(p).map(a => ({ from_message_id: orig.id, attachment_id: a.attachmentId, known: a }));
    const refs = (header(p, 'References') ?? '').split(/\s+/).filter(Boolean);
    const mid = header(p, 'Message-ID');
    if (mid && !refs.includes(mid)) refs.push(mid);

    const message: OutgoingMessage = {
      from: this.from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: ensurePrefix(header(p, 'Subject') ?? '', 'Fwd'),
      ...signed,
      references: refs,
      inReplyTo: mid,
      attachments: await this.resolveAttachments([...originals, ...(input.attachments ?? [])]),
    };
    this.validate(message);
    return { message, threadId: orig.threadId };
  }

  // ───────────── Envio (com limites e auditoria) ─────────────

  private async rawPayload(message: OutgoingMessage) {
    const raw = await buildRawMessage(message);
    if (raw.length > MAX_MESSAGE_BYTES * 1.4) throw new Error('Mensagem grande demais para o Gmail.');
    return raw;
  }

  private async effectiveRecipients(messageId: string) {
    const m = await this.gw.request<GmailMessage>({
      method: 'GET',
      path: `/messages/${messageId}`,
      query: { format: 'metadata', metadataHeaders: ['To', 'Cc', 'Bcc'] },
    });
    const list = (h: string) => parseAddresses([header(m.payload, h)]).map(a => a.address);
    return { message: m, recipients: { to: list('To'), cc: list('Cc'), bcc: list('Bcc') } };
  }

  async sendComposed(tool: string, message: OutgoingMessage, threadId?: string): Promise<SendResult> {
    const count = countRecipients(message);
    const auditId = await this.guard.reserve(tool, count);
    try {
      const raw = await this.rawPayload(message);
      const sent =
        raw.length <= RAW_JSON_MAX_BYTES
          ? await this.gw.request<{ id: string; threadId: string }>({
              method: 'POST',
              path: '/messages/send',
              json: { raw: raw.toString('base64url'), ...(threadId ? { threadId } : {}) },
            })
          : await this.gw.request<{ id: string; threadId: string }>({
              method: 'POST',
              path: '/messages/send',
              upload: { metadata: threadId ? { threadId } : {}, rfc822: raw },
            });
      const eff = await this.effectiveRecipients(sent.id).catch(() => null);
      const recipients = eff?.recipients ?? {
        to: parseAddresses(message.to ?? []).map(a => a.address),
        cc: parseAddresses(message.cc ?? []).map(a => a.address),
        bcc: parseAddresses(message.bcc ?? []).map(a => a.address),
      };
      await this.guard.complete(auditId, sent.id, sent.threadId, count);
      return { messageId: sent.id, threadId: sent.threadId, recipients, recipientCount: count };
    } catch (e) {
      await this.guard.fail(auditId);
      throw e;
    }
  }

  async sendDraft(draftId: string): Promise<SendResult> {
    const d = await this.gw.request<{ id: string; message: GmailMessage }>({
      method: 'GET',
      path: `/drafts/${draftId}`,
      query: { format: 'metadata', metadataHeaders: ['To', 'Cc', 'Bcc'] },
    });
    const p = d.message.payload;
    const count = parseAddresses([header(p, 'To'), header(p, 'Cc'), header(p, 'Bcc')]).length;
    const auditId = await this.guard.reserve('send_draft', count);
    try {
      const sent = await this.gw.request<{ id: string; threadId: string }>({ method: 'POST', path: '/drafts/send', json: { id: draftId } });
      const eff = await this.effectiveRecipients(sent.id).catch(() => null);
      const list = (h: string) => parseAddresses([header(p, h)]).map(a => a.address);
      await this.guard.complete(auditId, sent.id, sent.threadId, count);
      return {
        messageId: sent.id,
        threadId: sent.threadId,
        recipients: eff?.recipients ?? { to: list('To'), cc: list('Cc'), bcc: list('Bcc') },
        recipientCount: count,
      };
    } catch (e) {
      await this.guard.fail(auditId);
      throw e;
    }
  }

  // ───────────── Rascunhos ─────────────

  private async draftRequest(method: 'POST' | 'PUT', path: string, message: OutgoingMessage, threadId?: string) {
    const raw = await this.rawPayload(message);
    const meta = { message: threadId ? { threadId } : {} };
    const r =
      raw.length <= RAW_JSON_MAX_BYTES
        ? await this.gw.request<{ id: string; message: { id: string; threadId: string } }>({
            method,
            path,
            json: { ...(method === 'PUT' ? { id: path.split('/').pop() } : {}), message: { raw: raw.toString('base64url'), ...meta.message } },
          })
        : await this.gw.request<{ id: string; message: { id: string; threadId: string } }>({ method, path, upload: { metadata: meta, rfc822: raw } });
    return { draftId: r.id, messageId: r.message?.id, threadId: r.message?.threadId };
  }

  createDraft(message: OutgoingMessage, threadId?: string) {
    return this.draftRequest('POST', '/drafts', message, threadId);
  }

  updateDraft(draftId: string, message: OutgoingMessage, threadId?: string) {
    return this.draftRequest('PUT', `/drafts/${draftId}`, message, threadId);
  }

  async getDraftThreadId(draftId: string) {
    const d = await this.gw.request<{ message: GmailMessage }>({ method: 'GET', path: `/drafts/${draftId}`, query: { format: 'minimal' } });
    return d.message.threadId;
  }

  async listDrafts(pageToken: string | undefined, maxResults: number, query?: string) {
    const r = await this.gw.request<{ drafts?: { id: string }[]; nextPageToken?: string }>({
      method: 'GET',
      path: '/drafts',
      query: { pageToken, maxResults, q: query || undefined },
    });
    const drafts = await Promise.all(
      (r.drafts ?? []).map(async d => {
        const full = await this.gw.request<{ id: string; message: GmailMessage }>({
          method: 'GET',
          path: `/drafts/${d.id}`,
          query: { format: 'metadata', metadataHeaders: ['To', 'Cc', 'Subject', 'Date'] },
        });
        const p = full.message.payload;
        return {
          draftId: full.id,
          messageId: full.message.id,
          threadId: full.message.threadId,
          to: header(p, 'To'),
          cc: header(p, 'Cc'),
          subject: header(p, 'Subject'),
          date: header(p, 'Date'),
          snippet: full.message.snippet,
        };
      }),
    );
    return { drafts, nextPageToken: r.nextPageToken ?? null };
  }

  async getDraft(draftId: string) {
    const d = await this.gw.request<{ id: string; message: GmailMessage }>({ method: 'GET', path: `/drafts/${draftId}`, query: { format: 'full' } });
    return { draftId: d.id, ...summarizeMessage(d.message, { includeBody: true }), bcc: header(d.message.payload, 'Bcc') };
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
