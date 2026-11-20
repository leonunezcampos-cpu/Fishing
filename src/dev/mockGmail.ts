/**
 * SOMENTE DESENVOLVIMENTO/TESTES: Gmail simulado em memória, compatível com o subconjunto da API usado pelo gateway.
 * Registra todas as requisições recebidas (método + caminho) para os testes verificarem o que saiu.
 */
import type { GmailMessage, GmailPart } from '../gmail/parse.js';

interface Draft {
  id: string;
  messageId: string;
}

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');

function parseRaw(raw: Buffer): { headers: { name: string; value: string }[]; body: string } {
  const text = raw.toString('utf8');
  const idx = text.search(/\r?\n\r?\n/);
  const head = idx >= 0 ? text.slice(0, idx) : text;
  const body = idx >= 0 ? text.slice(idx).replace(/^\r?\n\r?\n/, '') : '';
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const headers = unfolded
    .split(/\r?\n/)
    .map(l => {
      const i = l.indexOf(':');
      return { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
    })
    .filter(h => h.name);
  return { headers, body };
}

export class MockGmail {
  requests: { method: string; path: string; body?: unknown }[] = [];
  sentRaw: Buffer[] = [];
  draftRaw = new Map<string, Buffer>();
  messages = new Map<string, GmailMessage>();
  attachments = new Map<string, Buffer>();
  drafts = new Map<string, Draft>();
  labels = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'UNREAD', name: 'UNREAD', type: 'system' },
    { id: 'SENT', name: 'SENT', type: 'system' },
    { id: 'TRASH', name: 'TRASH', type: 'system' },
    { id: 'Label_1', name: 'Clientes', type: 'user' },
  ];
  private seq = 100;

  constructor(private self: string) {
    this.seed();
  }

  private nextId() {
    return (this.seq++).toString(16).padStart(16, '0');
  }

  private seed() {
    const pdf = Buffer.from('%PDF-1.4 conteúdo de teste');
    this.attachments.set('att-1', pdf);
    this.addMessage({
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX', 'UNREAD'],
      headers: {
        From: 'Maria Souza <maria@example.com>',
        To: `${this.self}, joao@example.com`,
        Cc: 'ana@example.com',
        Subject: 'Reunião de amanhã — pauta',
        Date: 'Thu, 19 Nov 2026 10:00:00 -0300',
        'Message-ID': '<orig-1@example.com>',
        References: '<root-0@example.com>',
      },
      text: 'Olá, segue a pauta.\nAção: revisar o orçamento.',
      html: '<p>Olá, segue a <b>pauta</b>.</p><p>Ação: revisar o orçamento.</p>',
      attachment: { id: 'att-1', filename: 'pauta.pdf', mimeType: 'application/pdf', size: pdf.length },
    });
  }

  addMessage(m: {
    id: string;
    threadId: string;
    labelIds: string[];
    headers: Record<string, string>;
    text: string;
    html?: string;
    attachment?: { id: string; filename: string; mimeType: string; size: number };
  }) {
    const headers = Object.entries(m.headers).map(([name, value]) => ({ name, value }));
    const parts: GmailPart[] = [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }], body: { data: b64(m.text), size: m.text.length } },
          ...(m.html ? [{ mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }], body: { data: b64(m.html), size: m.html.length } }] : []),
        ],
      },
    ];
    if (m.attachment) {
      parts.push({ mimeType: m.attachment.mimeType, filename: m.attachment.filename, body: { attachmentId: m.attachment.id, size: m.attachment.size } });
    }
    this.messages.set(m.id, {
      id: m.id,
      threadId: m.threadId,
      labelIds: m.labelIds,
      snippet: m.text.slice(0, 80),
      payload: { mimeType: 'multipart/mixed', headers, parts },
    });
  }

  private storeRaw(raw: Buffer, threadId: string | undefined, labelIds: string[]) {
    const { headers, body } = parseRaw(raw);
    const id = this.nextId();
    const msg: GmailMessage = {
      id,
      threadId: threadId ?? id,
      labelIds,
      snippet: body.slice(0, 80),
      payload: { mimeType: 'text/plain', headers, body: { data: b64(body), size: body.length } },
    };
    this.messages.set(id, msg);
    return msg;
  }

  private thread(id: string) {
    return [...this.messages.values()].filter(m => m.threadId === id);
  }

  private parseMultipart(body: Buffer): { metadata: any; raw: Buffer } {
    const s = body.toString('latin1');
    const boundary = s.slice(2, s.indexOf('\r\n'));
    const parts = s.split(`--${boundary}`).filter(p => p.trim() && p.trim() !== '--');
    const meta = JSON.parse(parts[0].split('\r\n\r\n')[1].trim());
    const rawPart = parts[1];
    const raw = Buffer.from(rawPart.slice(rawPart.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, ''), 'latin1');
    return { metadata: meta, raw };
  }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const upload = u.pathname.startsWith('/upload/');
    const path = u.pathname.replace(/^\/(upload\/)?gmail\/v1\/users\/me/, '');
    const method = init.method ?? 'GET';
    let body: any;
    let rawFromUpload: Buffer | undefined;
    if (upload) {
      const mp = this.parseMultipart(Buffer.from(init.body as Uint8Array));
      body = mp.metadata;
      rawFromUpload = mp.raw;
    } else if (typeof init.body === 'string') body = JSON.parse(init.body);
    this.requests.push({ method, path: (upload ? '[upload]' : '') + path, body });

    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    const notFound = () => new Response(JSON.stringify({ error: { status: 'NOT_FOUND' } }), { status: 404 });
    let m: RegExpExecArray | null;

    if (method === 'GET' && path === '/profile') return ok({ emailAddress: this.self });
    if (method === 'GET' && path === '/labels') return ok({ labels: this.labels });
    if (method === 'GET' && path === '/threads') {
      const ids = [...new Set([...this.messages.values()].map(x => x.threadId))];
      return ok({ threads: ids.map(id => ({ id })), resultSizeEstimate: ids.length });
    }
    if (method === 'GET' && (m = /^\/threads\/([^/]+)$/.exec(path))) {
      const msgs = this.thread(m[1]);
      return msgs.length ? ok({ id: m[1], messages: msgs }) : notFound();
    }
    if (method === 'POST' && (m = /^\/threads\/([^/]+)\/modify$/.exec(path))) {
      for (const msg of this.thread(m[1])) this.modify(msg, body);
      return ok({ id: m[1] });
    }
    if (method === 'GET' && (m = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path))) {
      const a = this.attachments.get(m[2]);
      return a ? ok({ data: a.toString('base64url'), size: a.length }) : notFound();
    }
    if (method === 'GET' && (m = /^\/messages\/([^/]+)$/.exec(path))) {
      const msg = this.messages.get(m[1]);
      return msg ? ok(msg) : notFound();
    }
    if (method === 'POST' && (m = /^\/messages\/([^/]+)\/modify$/.exec(path)) && m[1] !== 'send') {
      const msg = this.messages.get(m[1]);
      if (!msg) return notFound();
      this.modify(msg, body);
      return ok(msg);
    }
    if (method === 'POST' && path === '/messages/send') {
      const raw = rawFromUpload ?? Buffer.from(body.raw, 'base64url');
      this.sentRaw.push(raw);
      const msg = this.storeRaw(raw, body.threadId, ['SENT']);
      return ok({ id: msg.id, threadId: msg.threadId, labelIds: ['SENT'] });
    }
    if (method === 'GET' && path === '/drafts') {
      return ok({ drafts: [...this.drafts.values()].map(d => ({ id: d.id, message: { id: d.messageId } })) });
    }
    if (method === 'GET' && (m = /^\/drafts\/([^/]+)$/.exec(path))) {
      const d = this.drafts.get(m[1]);
      return d ? ok({ id: d.id, message: this.messages.get(d.messageId) }) : notFound();
    }
    if ((method === 'POST' && path === '/drafts') || (method === 'PUT' && (m = /^\/drafts\/([^/]+)$/.exec(path)))) {
      const raw = rawFromUpload ?? Buffer.from(body.message.raw, 'base64url');
      const msg = this.storeRaw(raw, body.message?.threadId, ['DRAFT']);
      const id = method === 'PUT' ? m![1] : `r-${this.nextId()}`;
      if (method === 'PUT') {
        const old = this.drafts.get(id);
        if (!old) return notFound();
        this.messages.delete(old.messageId);
      }
      this.draftRaw.set(id, raw);
      this.drafts.set(id, { id, messageId: msg.id });
      return ok({ id, message: { id: msg.id, threadId: msg.threadId } });
    }
    if (method === 'POST' && path === '/drafts/send') {
      const d = this.drafts.get(body.id);
      if (!d) return notFound();
      const msg = this.messages.get(d.messageId)!;
      msg.labelIds = ['SENT'];
      this.sentRaw.push(this.draftRaw.get(d.id)!);
      this.drafts.delete(d.id);
      return ok({ id: msg.id, threadId: msg.threadId, labelIds: ['SENT'] });
    }
    return new Response(JSON.stringify({ error: { status: 'MOCK_UNSUPPORTED' } }), { status: 400 });
  };

  private modify(msg: GmailMessage, body: { addLabelIds?: string[]; removeLabelIds?: string[] }) {
    const set = new Set(msg.labelIds ?? []);
    for (const l of body.addLabelIds ?? []) set.add(l);
    for (const l of body.removeLabelIds ?? []) set.delete(l);
    msg.labelIds = [...set];
  }
}
