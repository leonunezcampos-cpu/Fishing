/**
 * ÚNICO ponto de saída para a Gmail API.
 *
 * O escopo gmail.modify tecnicamente permite mover para a lixeira (messages.trash / threads.trash).
 * Este gateway garante, no código, que isso nunca aconteça: só passa o que está na lista branca abaixo.
 * Tudo o mais (trash, untrash, delete, batchDelete, settings/*, import, insert, watch, history…) é recusado
 * ANTES de qualquer requisição de rede. Coberto por tests/gateway.test.ts.
 */

export class ForbiddenGmailOperationError extends Error {
  constructor(method: string, path: string) {
    super(`Operação do Gmail não permitida por este servidor: ${method} ${path}`);
    this.name = 'ForbiddenGmailOperationError';
  }
}

export class GmailApiError extends Error {
  constructor(public status: number, public reason: string) {
    super(`Gmail API respondeu ${status}${reason ? ` (${reason})` : ''}`);
    this.name = 'GmailApiError';
  }
}

const ID = '[A-Za-z0-9_-]{1,200}';

type Method = 'GET' | 'POST' | 'PUT';
interface Rule {
  method: Method;
  pattern: RegExp;
  name: string;
}

/** Caminhos relativos a /gmail/v1/users/me (ou /upload/gmail/v1/users/me quando upload=true). */
const API_RULES: Rule[] = [
  { method: 'GET', pattern: /^\/profile$/, name: 'users.getProfile' },
  { method: 'GET', pattern: /^\/threads$/, name: 'threads.list' },
  { method: 'GET', pattern: new RegExp(`^/threads/${ID}$`), name: 'threads.get' },
  { method: 'POST', pattern: new RegExp(`^/threads/${ID}/modify$`), name: 'threads.modify' },
  { method: 'GET', pattern: new RegExp(`^/messages/${ID}$`), name: 'messages.get' },
  { method: 'GET', pattern: new RegExp(`^/messages/${ID}/attachments/${ID}$`), name: 'messages.attachments.get' },
  { method: 'POST', pattern: new RegExp(`^/messages/${ID}/modify$`), name: 'messages.modify' },
  { method: 'POST', pattern: /^\/messages\/send$/, name: 'messages.send' },
  { method: 'GET', pattern: /^\/labels$/, name: 'labels.list' },
  { method: 'GET', pattern: /^\/drafts$/, name: 'drafts.list' },
  { method: 'GET', pattern: new RegExp(`^/drafts/${ID}$`), name: 'drafts.get' },
  { method: 'POST', pattern: /^\/drafts$/, name: 'drafts.create' },
  { method: 'PUT', pattern: new RegExp(`^/drafts/${ID}$`), name: 'drafts.update' },
  { method: 'POST', pattern: /^\/drafts\/send$/, name: 'drafts.send' },
];

const UPLOAD_RULES: Rule[] = [
  { method: 'POST', pattern: /^\/messages\/send$/, name: 'upload.messages.send' },
  { method: 'POST', pattern: /^\/drafts$/, name: 'upload.drafts.create' },
  { method: 'PUT', pattern: new RegExp(`^/drafts/${ID}$`), name: 'upload.drafts.update' },
];

/** Rótulos de sistema que nunca podem ser adicionados ou removidos via modify. */
const PROTECTED_LABELS = new Set(['TRASH', 'SPAM']);

export function assertAllowed(method: string, path: string, upload = false, body?: unknown): Rule {
  const rules = upload ? UPLOAD_RULES : API_RULES;
  // Bloqueia qualquer tentativa de escapar do caminho (../, %2F, //, query embutida).
  if (/[^A-Za-z0-9_\-/]/.test(path) || path.includes('//')) throw new ForbiddenGmailOperationError(method, path);
  const rule = rules.find(r => r.method === method && r.pattern.test(path));
  if (!rule) throw new ForbiddenGmailOperationError(method, path);
  if (rule.name.endsWith('.modify') && body && typeof body === 'object') {
    const b = body as { addLabelIds?: string[]; removeLabelIds?: string[] };
    for (const l of [...(b.addLabelIds ?? []), ...(b.removeLabelIds ?? [])]) {
      if (PROTECTED_LABELS.has(String(l).toUpperCase())) throw new ForbiddenGmailOperationError(method, `${path} [${l}]`);
    }
  }
  return rule;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GatewayRequest {
  method: Method;
  path: string;
  query?: Record<string, string | number | boolean | string[] | undefined>;
  json?: unknown;
  /** Upload multipart (mensagens grandes): metadados JSON + message/rfc822. */
  upload?: { metadata: unknown; rfc822: Buffer };
}

export class GmailGateway {
  constructor(
    private getAccessToken: () => Promise<string>,
    private fetchImpl: FetchLike = (u, i) => fetch(u, i),
    private onUnauthorized?: () => void,
  ) {}

  async request<T = any>(req: GatewayRequest): Promise<T> {
    const isUpload = !!req.upload;
    assertAllowed(req.method, req.path, isUpload, req.json);

    const base = isUpload ? 'https://gmail.googleapis.com/upload/gmail/v1/users/me' : 'https://gmail.googleapis.com/gmail/v1/users/me';
    const url = new URL(base + req.path);
    if (isUpload) url.searchParams.set('uploadType', 'multipart');
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x));
      else url.searchParams.set(k, String(v));
    }

    const doFetch = async () => {
      const headers: Record<string, string> = { authorization: `Bearer ${await this.getAccessToken()}` };
      let body: BodyInit | undefined;
      if (req.upload) {
        const boundary = `gmcp_${Math.random().toString(36).slice(2)}`;
        headers['content-type'] = `multipart/related; boundary=${boundary}`;
        body = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(req.upload.metadata)}\r\n`),
          Buffer.from(`--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`),
          req.upload.rfc822,
          Buffer.from(`\r\n--${boundary}--`),
        ]);
      } else if (req.json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(req.json);
      }
      return this.fetchImpl(url.toString(), { method: req.method, headers, body });
    };

    let res = await doFetch();
    if (res.status === 401 && this.onUnauthorized) {
      this.onUnauthorized();
      res = await doFetch();
    }
    if (!res.ok) {
      let reason = '';
      try {
        const j = (await res.json()) as any;
        reason = j?.error?.errors?.[0]?.reason ?? j?.error?.status ?? '';
      } catch {
        /* sem corpo */
      }
      throw new GmailApiError(res.status, reason);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}
