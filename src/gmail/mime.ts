import MailComposer from 'nodemailer/lib/mail-composer';
import addressparser from 'nodemailer/lib/addressparser';

export interface OutgoingAttachment {
  filename: string;
  mimeType?: string;
  content: Buffer;
}

export interface OutgoingMessage {
  from: string; // "Nome <email>" ou só email
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: OutgoingAttachment[];
  inReplyTo?: string;
  references?: string[];
}

export interface Signature {
  text?: string;
  html?: string;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Acrescenta a assinatura ao corpo (delimitador padrão "-- "). */
export function applySignature(body: { text?: string; html?: string }, sig?: Signature) {
  if (!sig?.text && !sig?.html) return body;
  const out = { ...body };
  const sigText = sig.text ?? '';
  if (out.text !== undefined) out.text = `${out.text.replace(/\s+$/, '')}\n\n-- \n${sigText}`;
  if (out.html !== undefined) {
    const sigHtml = sig.html ?? escapeHtml(sigText).replace(/\n/g, '<br>');
    out.html = `${out.html}<br><br>-- <br>${sigHtml}`;
  }
  return out;
}

/** Lista de endereços únicos (minúsculos) a partir de cabeçalhos/strings no formato RFC 5322. */
export function parseAddresses(values: (string | undefined | null)[]): { name: string; address: string }[] {
  const seen = new Set<string>();
  const out: { name: string; address: string }[] = [];
  const walk = (list: any[]) => {
    for (const a of list) {
      if (a.group) walk(a.group);
      else if (a.address) {
        const key = String(a.address).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ name: a.name ?? '', address: a.address });
        }
      }
    }
  };
  for (const v of values) if (v) walk(addressparser(v) as any[]);
  return out;
}

export function formatAddress(a: { name: string; address: string }) {
  return a.name ? `${JSON.stringify(a.name)} <${a.address}>` : a.address;
}

export function countRecipients(m: Pick<OutgoingMessage, 'to' | 'cc' | 'bcc'>) {
  return parseAddresses([...(m.to ?? []), ...(m.cc ?? []), ...(m.bcc ?? [])]).length;
}

const SIMPLE_EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/** Valida que cada entrada contém exatamente endereços de e-mail sintaticamente válidos. */
export function validateRecipients(list: string[] | undefined, field: string) {
  for (const entry of list ?? []) {
    const parsed = parseAddresses([entry]);
    if (parsed.length === 0 || parsed.some(p => !SIMPLE_EMAIL.test(p.address))) {
      throw new Error(`Endereço inválido em "${field}".`);
    }
  }
}

export function ensurePrefix(subject: string, prefix: 'Re' | 'Fwd') {
  const s = (subject ?? '').trim();
  const re = prefix === 'Re' ? /^(re|res|resp)\s*:/i : /^(fwd?|enc|encaminhad[ao])\s*:/i;
  return re.test(s) ? s : `${prefix}: ${s}`;
}

/** Monta a mensagem RFC 5322 (UTF-8; assunto em RFC 2047; anexos em base64). */
export async function buildRawMessage(m: OutgoingMessage): Promise<Buffer> {
  if (!m.text && !m.html) throw new Error('Informe o corpo em texto e/ou HTML.');
  const composer = new MailComposer({
    from: m.from,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    text: m.text,
    html: m.html,
    inReplyTo: m.inReplyTo,
    references: m.references,
    textEncoding: 'quoted-printable',
    // Nunca ler arquivos locais nem URLs: só conteúdo em memória.
    disableFileAccess: true,
    disableUrlAccess: true,
    attachments: (m.attachments ?? []).map(a => ({
      filename: a.filename,
      content: a.content,
      contentType: a.mimeType,
    })),
  } as any);
  const node = composer.compile();
  // O Gmail precisa do cabeçalho Bcc no raw para entregar às cópias ocultas (ele o remove antes do envio).
  (node as any).keepBcc = true;
  return new Promise((resolve, reject) => node.build((err: Error | null, buf: Buffer) => (err ? reject(err) : resolve(buf))));
}

export function toBase64Url(buf: Buffer) {
  return buf.toString('base64url');
}

export interface OriginalHeaders {
  messageId?: string;
  references?: string;
  subject?: string;
  from?: string;
  replyTo?: string;
  to?: string;
  cc?: string;
}

/**
 * Cabeçalhos de resposta corretos para manter o encadeamento (RFC 5322 §3.6.4):
 * In-Reply-To = Message-ID original; References = References originais + Message-ID original.
 */
export function buildReplyEnvelope(orig: OriginalHeaders, selfEmail: string, replyAll: boolean) {
  const self = selfEmail.toLowerCase();
  const fromList = parseAddresses([orig.from]);
  const sentByMe = fromList.some(a => a.address.toLowerCase() === self);

  let to = sentByMe ? parseAddresses([orig.to]) : parseAddresses([orig.replyTo || orig.from]);
  let cc: { name: string; address: string }[] = [];
  if (replyAll) {
    const pool = sentByMe ? parseAddresses([orig.cc]) : parseAddresses([orig.to, orig.cc]);
    const inTo = new Set(to.map(a => a.address.toLowerCase()));
    cc = pool.filter(a => a.address.toLowerCase() !== self && !inTo.has(a.address.toLowerCase()));
  }
  to = to.filter(a => a.address.toLowerCase() !== self || sentByMe);

  const refs = (orig.references ?? '').split(/\s+/).filter(Boolean);
  if (orig.messageId && !refs.includes(orig.messageId)) refs.push(orig.messageId);

  return {
    to: to.map(formatAddress),
    cc: cc.map(formatAddress),
    subject: ensurePrefix(orig.subject ?? '', 'Re'),
    inReplyTo: orig.messageId,
    references: refs,
  };
}
