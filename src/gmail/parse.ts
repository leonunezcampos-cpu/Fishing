import { convert } from 'html-to-text';

export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
  sizeEstimate?: number;
}

export function header(part: GmailPart | undefined, name: string): string | undefined {
  const n = name.toLowerCase();
  return part?.headers?.find(h => h.name.toLowerCase() === n)?.value;
}

function charsetOf(part: GmailPart): string {
  const ct = header(part, 'Content-Type') ?? '';
  const m = /charset="?([^";\s]+)"?/i.exec(ct);
  return (m?.[1] ?? 'utf-8').toLowerCase();
}

function decodeData(part: GmailPart): string {
  const data = part.body?.data;
  if (!data) return '';
  const buf = Buffer.from(data, 'base64url');
  try {
    return new TextDecoder(charsetOf(part)).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
    ],
  }).trim();
}

function walk(part: GmailPart | undefined, visit: (p: GmailPart) => void) {
  if (!part) return;
  visit(part);
  for (const p of part.parts ?? []) walk(p, visit);
}

function isAttachment(p: GmailPart) {
  return !!p.filename && !!p.body?.attachmentId;
}

/** Corpo em texto: prefere text/plain; senão converte o text/html. */
export function extractBody(payload: GmailPart | undefined): { text: string; hasHtml: boolean; html?: string } {
  let plain: string | undefined;
  let html: string | undefined;
  walk(payload, p => {
    if (isAttachment(p)) return;
    const disp = header(p, 'Content-Disposition') ?? '';
    if (/^attachment/i.test(disp)) return;
    if (p.mimeType === 'text/plain' && plain === undefined) plain = decodeData(p);
    else if (p.mimeType === 'text/html' && html === undefined) html = decodeData(p);
  });
  const text = plain?.trim() ? plain : html ? htmlToText(html) : '';
  return { text: text.replace(/\r\n/g, '\n'), hasHtml: html !== undefined, html };
}

export interface AttachmentInfo {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export function listAttachments(payload: GmailPart | undefined): AttachmentInfo[] {
  const out: AttachmentInfo[] = [];
  walk(payload, p => {
    if (isAttachment(p)) {
      out.push({ attachmentId: p.body!.attachmentId!, filename: p.filename!, mimeType: p.mimeType ?? 'application/octet-stream', size: p.body?.size ?? 0 });
    }
  });
  return out;
}

export function truncate(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max)}\n\n[… corpo truncado: ${s.length - max} caracteres omitidos. Use get_message para o texto completo.]` : s;
}

/** Resumo de mensagem para resposta das ferramentas. */
export function summarizeMessage(m: GmailMessage, opts: { includeBody: boolean; maxBodyChars?: number }) {
  const p = m.payload;
  const base = {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds ?? [],
    date: header(p, 'Date'),
    from: header(p, 'From'),
    to: header(p, 'To'),
    cc: header(p, 'Cc'),
    subject: header(p, 'Subject'),
    snippet: m.snippet,
    unread: (m.labelIds ?? []).includes('UNREAD'),
    attachments: listAttachments(p),
  };
  if (!opts.includeBody) return base;
  const body = extractBody(p);
  return { ...base, body: opts.maxBodyChars ? truncate(body.text, opts.maxBodyChars) : body.text };
}
