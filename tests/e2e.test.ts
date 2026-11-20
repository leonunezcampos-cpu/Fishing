import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { simpleParser } from 'mailparser';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig, CLAUDE_REDIRECT_URI } from '../src/config.js';
import { FakeGoogleOAuth } from '../src/auth/google.js';
import { MemoryStore } from '../src/store/memory.js';
import { MockGmail } from '../src/dev/mockGmail.js';
import { decryptSecret } from '../src/crypto.js';
import { TOOL_NAMES } from '../src/tools/index.js';

const BASE = 'http://localhost:3999';
const SELF = 'leonunezcampos@gmail.com';

function setup(env: Record<string, string> = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: BASE,
    STORE: 'memory',
    DEV_FAKE_GOOGLE: '1',
    SEND_DAILY_LIMIT: '3',
    SEND_MAX_RECIPIENTS: '3',
    EMAIL_SIGNATURE: 'Léo\\nEnviado pelo assistente',
    ...env,
  });
  const store = new MemoryStore();
  const google = new FakeGoogleOAuth(config.googleRedirectUri, config.allowedEmail);
  const gmail = new MockGmail(SELF);
  const { app } = createApp({ config, store, google, gmailFetch: gmail.fetch });
  return { app, store, gmail, config };
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function register(app: any, redirect = CLAUDE_REDIRECT_URI) {
  return request(app)
    .post('/register')
    .send({ redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], client_name: 'Claude' });
}

/** Executa o fluxo completo como o claude.ai faria. `googleEmail` simula a conta escolhida na tela do Google. */
async function authorize(app: any, googleEmail = SELF) {
  const reg = await register(app);
  const clientId = reg.body.client_id;
  const { verifier, challenge } = pkce();
  const auth = await request(app).get('/authorize').query({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'estado-do-claude',
    resource: `${BASE}/mcp`,
  });
  expect(auth.status).toBe(302);
  const googleUrl = new URL(auth.headers.location);
  expect(googleUrl.pathname).toBe('/oauth/google/callback');
  const cb = await request(app).get('/oauth/google/callback').query({ state: googleUrl.searchParams.get('state'), code: `fake:${googleEmail}` });
  return { cb, clientId, verifier };
}

async function fullLogin(app: any) {
  const { cb, clientId, verifier } = await authorize(app);
  expect(cb.status).toBe(302);
  const back = new URL(cb.headers.location);
  expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_REDIRECT_URI);
  expect(back.searchParams.get('state')).toBe('estado-do-claude');
  const code = back.searchParams.get('code')!;
  const tok = await request(app)
    .post('/token')
    .type('form')
    .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: CLAUDE_REDIRECT_URI, resource: `${BASE}/mcp` });
  expect(tok.status).toBe(200);
  return { ...tok.body, clientId, code, verifier };
}

let rpcId = 1;
async function mcp(app: any, token: string, method: string, params: unknown = {}) {
  const r = await request(app)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .set('MCP-Protocol-Version', '2025-06-18')
    .send({ jsonrpc: '2.0', id: rpcId++, method, params });
  return r;
}
async function callTool(app: any, token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await mcp(app, token, 'tools/call', { name, arguments: args });
  expect(r.status).toBe(200);
  const result = r.body.result;
  const text = result.content?.[0]?.text ?? '';
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { result, data, isError: !!result.isError, text };
}

describe('discovery (o que o claude.ai lê primeiro)', () => {
  it('/mcp sem token → 401 com WWW-Authenticate apontando o resource_metadata', async () => {
    const { app } = setup();
    const r = await request(app).post('/mcp').send({});
    expect(r.status).toBe(401);
    expect(r.headers['www-authenticate']).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('protected resource metadata: resource igual à URL do MCP', async () => {
    const { app } = setup();
    for (const p of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const r = await request(app).get(p);
      expect(r.status).toBe(200);
      expect(r.body.resource).toBe(`${BASE}/mcp`);
      expect(r.body.authorization_servers[0]).toBe(`${BASE}/`);
    }
  });

  it('authorization server metadata com PKCE S256, DCR e revogação', async () => {
    const { app } = setup();
    const r = await request(app).get('/.well-known/oauth-authorization-server');
    expect(r.body).toMatchObject({
      code_challenge_methods_supported: ['S256'],
      registration_endpoint: `${BASE}/register`,
      token_endpoint: `${BASE}/token`,
      revocation_endpoint: `${BASE}/revoke`,
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
    expect(r.body.token_endpoint_auth_methods_supported).toContain('none');
  });
});

describe('OAuth em duas pernas', () => {
  it('registro dinâmico só aceita o callback do claude.ai', async () => {
    const { app } = setup();
    expect((await register(app)).status).toBe(201);
    expect((await register(app, 'https://atacante.example.com/cb')).status).toBe(400);
    expect((await register(app, 'http://localhost:6274/oauth/callback')).status).toBe(400);
    const dev = setup({ ALLOW_LOCALHOST_REDIRECTS: '1' });
    expect((await register(dev.app, 'http://localhost:6274/oauth/callback')).status).toBe(201);
  });

  it('fluxo completo emite tokens e guarda o refresh token do Google CIFRADO', async () => {
    const { app, store, config } = setup();
    const t = await fullLogin(app);
    expect(t.access_token).toMatch(/^gma_/);
    expect(t.refresh_token).toMatch(/^gmr_/);
    expect(t.expires_in).toBe(3600);
    const cred = await store.getGoogleCredential(SELF);
    expect(cred).toBeDefined();
    expect(JSON.stringify(cred)).not.toContain('fake-google-refresh');
    expect(decryptSecret(cred!.secret, config.encryptionKey, SELF)).toBe('fake-google-refresh');
    // Tokens guardados só como hash
    for (const k of store.tokens.keys()) expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...store.tokens.values()])).not.toContain(t.access_token);
  });

  it('outra conta Google é recusada com erro e nada é gravado', async () => {
    const { app, store } = setup();
    const { cb } = await authorize(app, 'outra.pessoa@gmail.com');
    expect(cb.status).toBe(403);
    expect(cb.text).toContain('não está autorizada');
    expect(cb.headers.location).toBeUndefined();
    expect(store.google.size).toBe(0);
    expect(store.codes.size).toBe(0);
  });

  it('código de autorização é de uso único e exige o code_verifier correto', async () => {
    const { app } = setup();
    const { cb, clientId, verifier } = await authorize(app);
    const code = new URL(cb.headers.location).searchParams.get('code')!;
    const bad = await request(app).post('/token').type('form').send({ grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), client_id: clientId });
    expect(bad.status).toBe(400);
    const ok = await request(app).post('/token').type('form').send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId });
    expect(ok.status).toBe(200);
    const again = await request(app).post('/token').type('form').send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId });
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
  });

  it('state inválido no callback do Google é recusado', async () => {
    const { app } = setup();
    const r = await request(app).get('/oauth/google/callback').query({ state: 'inventado', code: `fake:${SELF}` });
    expect(r.status).toBe(400);
  });

  it('refresh com rotação; reuso do refresh antigo revoga a família inteira', async () => {
    const { app } = setup();
    const t = await fullLogin(app);
    const r1 = await request(app).post('/token').type('form').send({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(t.refresh_token);
    expect((await mcp(app, r1.body.access_token, 'tools/list')).status).toBe(200);

    const reuse = await request(app).post('/token').type('form').send({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');
    // Família revogada: o access token novo também morreu
    expect((await mcp(app, r1.body.access_token, 'tools/list')).status).toBe(401);
  });

  it('revogação (RFC 7009) derruba access e refresh', async () => {
    const { app } = setup();
    const t = await fullLogin(app);
    expect((await mcp(app, t.access_token, 'tools/list')).status).toBe(200);
    const rv = await request(app).post('/revoke').type('form').send({ token: t.refresh_token, client_id: t.clientId });
    expect(rv.status).toBe(200);
    expect((await mcp(app, t.access_token, 'tools/list')).status).toBe(401);
    const r = await request(app).post('/token').type('form').send({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.clientId });
    expect(r.body.error).toBe('invalid_grant');
  });

  it('token expirado é recusado', async () => {
    const { app } = setup({ ACCESS_TOKEN_TTL_SECONDS: '1' });
    const t = await fullLogin(app);
    await new Promise(r => setTimeout(r, 1100));
    expect((await mcp(app, t.access_token, 'tools/list')).status).toBe(401);
  });
});

describe('ferramentas MCP (Gmail simulado)', () => {
  let ctx: ReturnType<typeof setup>;
  let token: string;
  beforeEach(async () => {
    ctx = setup();
    token = (await fullLogin(ctx.app)).access_token;
  });

  it('lista exatamente as ferramentas previstas, com destructiveHint nas de envio', async () => {
    const r = await mcp(ctx.app, token, 'tools/list');
    const tools = r.body.result.tools as any[];
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(names).toEqual(
      [
        'archive_thread', 'create_draft', 'download_attachment', 'forward', 'get_draft', 'get_message', 'get_thread', 'label_thread',
        'list_drafts', 'list_labels', 'mark_read', 'mark_unread', 'reply', 'search_threads', 'send_draft', 'send_message', 'unlabel_thread', 'update_draft',
      ].sort(),
    );
    for (const t of tools) {
      const isSend = ['send_message', 'reply', 'forward', 'send_draft'].includes(t.name);
      expect(t.annotations.destructiveHint).toBe(isSend);
      if (isSend) expect(t.description).toMatch(/confirmação EXPLÍCITA/);
    }
  });

  it('search_threads, get_thread, get_message (HTML → texto), list_labels', async () => {
    const s = await callTool(ctx.app, token, 'search_threads', { query: 'is:unread' });
    expect(s.data.threads[0]).toMatchObject({ threadId: 't1', subject: 'Reunião de amanhã — pauta', unread: true, messageCount: 1 });
    const th = await callTool(ctx.app, token, 'get_thread', { thread_id: 't1' });
    expect(th.data.messages[0].body).toContain('Ação: revisar o orçamento.');
    const m = await callTool(ctx.app, token, 'get_message', { message_id: 'm1' });
    expect(m.data.attachments[0]).toMatchObject({ filename: 'pauta.pdf', attachmentId: 'att-1' });
    const l = await callTool(ctx.app, token, 'list_labels');
    expect(l.data.map((x: any) => x.name)).toContain('Clientes');
  });

  it('download_attachment inline e via link temporário', async () => {
    const inline = await callTool(ctx.app, token, 'download_attachment', { message_id: 'm1', attachment_id: 'att-1' });
    const res = inline.result.content[1].resource;
    expect(Buffer.from(res.blob, 'base64').toString()).toContain('%PDF-1.4');

    const small = setup({ ATTACHMENT_INLINE_MAX_BYTES: '5' });
    const tk = (await fullLogin(small.app)).access_token;
    const linked = await callTool(small.app, tk, 'download_attachment', { message_id: 'm1', attachment_id: 'att-1' });
    expect(linked.data.delivery).toBe('link');
    const url = new URL(linked.data.url);
    const dl = await request(small.app).get(url.pathname + url.search).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain("filename*=UTF-8''pauta.pdf");
    expect((dl.body as Buffer).toString()).toContain('%PDF-1.4');
    const tampered = await request(small.app).get(url.pathname + '?t=' + url.searchParams.get('t')!.slice(0, -2) + 'xx');
    expect(tampered.status).toBe(410);
  });

  it('organização: label/unlabel/archive/mark_read/mark_unread', async () => {
    const msg = () => ctx.gmail.messages.get('m1')!;
    await callTool(ctx.app, token, 'label_thread', { thread_id: 't1', labels: ['clientes'] });
    expect(msg().labelIds).toContain('Label_1');
    await callTool(ctx.app, token, 'unlabel_thread', { thread_id: 't1', labels: ['Clientes'] });
    expect(msg().labelIds).not.toContain('Label_1');
    await callTool(ctx.app, token, 'mark_read', { thread_id: 't1' });
    expect(msg().labelIds).not.toContain('UNREAD');
    await callTool(ctx.app, token, 'mark_unread', { message_id: 'm1' });
    expect(msg().labelIds).toContain('UNREAD');
    await callTool(ctx.app, token, 'archive_thread', { thread_id: 't1' });
    expect(msg().labelIds).not.toContain('INBOX');
    const bad = await callTool(ctx.app, token, 'label_thread', { thread_id: 't1', labels: ['TRASH'] });
    expect(bad.isError).toBe(true);
    expect(msg().labelIds).not.toContain('TRASH');
  });

  it('tentar escapar pelo ID não chega ao Gmail', async () => {
    const r = await callTool(ctx.app, token, 'get_thread', { thread_id: 'abc/trash' });
    expect(r.isError).toBe(true);
    expect(ctx.gmail.requests.some(q => q.path.includes('trash'))).toBe(false);
  });

  it('send_message: devolve ids e destinatários; MIME com acentos e assinatura; auditoria sem endereços', async () => {
    const r = await callTool(ctx.app, token, 'send_message', {
      to: [SELF],
      subject: 'Teste do conector — ação ✅',
      body_text: 'Olá! Coração e pão.',
      attachments: [{ filename: 'nota.txt', mime_type: 'text/plain', content_base64: Buffer.from('conteúdo').toString('base64') }],
    });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ recipients: { to: [SELF] }, recipientCount: 1 });
    expect(r.data.messageId).toBeTruthy();
    expect(r.data.threadId).toBeTruthy();
    const parsed = await simpleParser(ctx.gmail.sentRaw[0]);
    expect(parsed.subject).toBe('Teste do conector — ação ✅');
    expect(parsed.text).toContain('Olá! Coração e pão.\n\n-- \nLéo\nEnviado pelo assistente');
    expect(parsed.attachments[0].filename).toBe('nota.txt');
    const audit = [...ctx.store.audit.values()];
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain('@');
    expect(audit[0]).toMatchObject({ status: 'sent', tool: 'send_message', recipientCount: 1, gmailMessageId: r.data.messageId });
  });

  it('reply_all: encadeamento correto na mesma thread, sem o próprio endereço', async () => {
    const r = await callTool(ctx.app, token, 'reply', { message_id: 'm1', reply_all: true, body_text: 'Combinado.' });
    expect(r.isError).toBe(false);
    expect(r.data.threadId).toBe('t1');
    const sendReq = ctx.gmail.requests.find(q => q.path === '/messages/send')!;
    expect((sendReq.body as any).threadId).toBe('t1');
    const parsed = await simpleParser(ctx.gmail.sentRaw[0]);
    expect(parsed.subject).toBe('Re: Reunião de amanhã — pauta');
    expect(parsed.inReplyTo).toBe('<orig-1@example.com>');
    expect(parsed.references).toEqual(['<root-0@example.com>', '<orig-1@example.com>']);
    expect((parsed.to as any).value.map((a: any) => a.address)).toEqual(['maria@example.com']);
    expect((parsed.cc as any).value.map((a: any) => a.address)).toEqual(['joao@example.com', 'ana@example.com']);
    expect(parsed.text).toContain('> Olá, segue a pauta.');
  });

  it('forward leva os anexos originais', async () => {
    const r = await callTool(ctx.app, token, 'forward', { message_id: 'm1', to: [SELF], note: 'Veja abaixo.' });
    expect(r.isError).toBe(false);
    const parsed = await simpleParser(ctx.gmail.sentRaw[0]);
    expect(parsed.subject).toBe('Fwd: Reunião de amanhã — pauta');
    expect(parsed.attachments.map(a => a.filename)).toEqual(['pauta.pdf']);
    expect(parsed.attachments[0].content.toString()).toContain('%PDF-1.4 conteúdo de teste');
    expect(parsed.text).toContain('---------- Mensagem encaminhada ----------');
  });

  it('rascunhos: criar (resposta na thread), atualizar, listar, ler e enviar', async () => {
    const c = await callTool(ctx.app, token, 'create_draft', { reply_to_message_id: 'm1', body_text: 'Rascunho v1' });
    expect(c.data.threadId).toBe('t1');
    const u = await callTool(ctx.app, token, 'update_draft', { draft_id: c.data.draftId, to: [SELF], subject: 'Novo assunto', body_text: 'Rascunho v2' });
    expect(u.isError).toBe(false);
    expect(u.data.threadId).toBe('t1');
    const l = await callTool(ctx.app, token, 'list_drafts');
    expect(l.data.drafts).toHaveLength(1);
    const g = await callTool(ctx.app, token, 'get_draft', { draft_id: c.data.draftId });
    expect(g.data.body).toContain('Rascunho v2');
    const s = await callTool(ctx.app, token, 'send_draft', { draft_id: c.data.draftId });
    expect(s.isError).toBe(false);
    expect(s.data.recipientCount).toBe(1);
    expect(s.data.messageId).toBeTruthy();
  });

  it('limites: destinatários por mensagem e envios por dia', async () => {
    const many = await callTool(ctx.app, token, 'send_message', { to: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'], subject: 's', body_text: 't' });
    expect(many.isError).toBe(true);
    expect(many.text).toMatch(/excede o limite de 3/);
    for (let i = 0; i < 3; i++) expect((await callTool(ctx.app, token, 'send_message', { to: [SELF], subject: `n${i}`, body_text: 't' })).isError).toBe(false);
    const over = await callTool(ctx.app, token, 'send_message', { to: [SELF], subject: 'x', body_text: 't' });
    expect(over.isError).toBe(true);
    expect(over.text).toMatch(/limite diário de 3/);
    expect(ctx.gmail.sentRaw).toHaveLength(3);
  });

  it('nenhuma requisição ao Gmail foi trash/delete durante todos os fluxos', async () => {
    await callTool(ctx.app, token, 'archive_thread', { thread_id: 't1' });
    await callTool(ctx.app, token, 'send_message', { to: [SELF], subject: 's', body_text: 't' });
    for (const q of ctx.gmail.requests) {
      expect(q.method).not.toBe('DELETE');
      expect(q.path).not.toMatch(/trash|batchDelete|settings/);
    }
  });
});
