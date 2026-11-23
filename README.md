# Gmail pessoal — servidor MCP remoto para o claude.ai

Conector personalizado (Streamable HTTP + OAuth 2.1/PKCE + registro dinâmico) que dá ao Claude acesso
à conta **leonunezcampos@gmail.com**, e só a ela. Deploy na Railway; dados no Postgres do Supabase (projeto core-ccl-prod, schema `gmail_mcp`, papel `gmail_mcp_app` que só enxerga esse schema).

**Produção:** `https://gmail-mcp-production-c64a2b60.up.railway.app/mcp` (projeto Railway `gmail-mcp-pessoal`, serviço `gmail-mcp`).

- [Arquitetura](#arquitetura)
- [Desenvolvimento local](#desenvolvimento-local)
- [Passo a passo manual (Google Cloud, Supabase, Railway)](#passo-a-passo-manual)
- [Roteiro de teste no claude.ai](#roteiro-de-teste-no-claudeai)
- [Como revogar o acesso](#como-revogar-o-acesso)
- [Segurança: o que o código garante](#segurança-o-que-o-código-garante)

---

## Arquitetura

```
claude.ai ──OAuth 2.1 + PKCE──▶ [este servidor = Authorization Server] ──OAuth──▶ Google
          ◀── token opaco ──────            │  Supabase: clientes, códigos, tokens (hash),
          ── POST /mcp (Bearer) ─▶ ferramentas    refresh do Google (AES-256-GCM), auditoria
                                         └─▶ GatewayGmail (lista branca) ──▶ Gmail API
```

| Rota | Função |
|---|---|
| `POST /mcp` | Endpoint MCP (Streamable HTTP, sem sessão). Sem token → `401` + `WWW-Authenticate: Bearer resource_metadata=…` |
| `/.well-known/oauth-protected-resource[/mcp]` | RFC 9728 (`resource` = URL exata do `/mcp`) |
| `/.well-known/oauth-authorization-server` | RFC 8414 (S256, DCR, revogação) |
| `POST /register` | Registro dinâmico (RFC 7591). Só aceita `https://claude.ai/api/mcp/auth_callback` |
| `GET /authorize` → Google → `GET /oauth/google/callback` | Perna Claude↔servidor↔Google; valida a conta pelo `id_token` |
| `POST /token` | Código (60 s, uso único) → access (1 h) + refresh (30 d, rotativo, reuso revoga a família) |
| `POST /revoke` | RFC 7009 |
| `GET /attachments/download?t=…` | Link temporário (HMAC, 10 min) para anexos grandes |

**Escopos do Google:** `openid email https://www.googleapis.com/auth/gmail.modify`.
`gmail.modify` já contém `gmail.readonly` e `gmail.compose` (ler, rascunhos, enviar, marcadores) e **não** permite
exclusão permanente nem alterar filtros/encaminhamento/delegação (esses exigem `https://mail.google.com/` ou
`gmail.settings.*`, que não são pedidos — e o servidor recusa a autorização se aparecerem). O único risco
remanescente do `gmail.modify` — mover para a lixeira — é bloqueado no `src/gmail/gateway.ts` e coberto por testes.

**Tabelas** (schema `gmail_mcp`, RLS ligado, política só para `gmail_mcp_app`): ver `supabase/migrations/`.

## Desenvolvimento local

```bash
npm install
npm test                  # 105 testes: conta permitida, cripto, MIME, limites, bloqueios, fluxo OAuth + ferramentas
npm run typecheck
npm run dev:mock          # servidor em http://localhost:3000 com Google e Gmail SIMULADOS
```

MCP Inspector contra o modo simulado (o login "Google" é automático):

```bash
ALLOW_LOCALHOST_REDIRECTS=1 npm run dev:mock
npx @modelcontextprotocol/inspector   # Transport: Streamable HTTP, URL: http://localhost:3000/mcp → Connect
```

Para testar localmente com o Google e o Gmail reais: crie `.env` a partir de `.env.example` com
`NODE_ENV=development`, `PUBLIC_BASE_URL=http://localhost:3000`, `ALLOW_LOCALHOST_REDIRECTS=1`, e rode `npm run dev`.

---

## Passo a passo manual

> Faça tudo logado com a conta **pessoal** (leonunezcampos@gmail.com), não com a do escritório.
> Nomes de menus mudam com frequência; se algo não bater, procure o equivalente.

### 1. Railway e Supabase — já feitos

- Railway: projeto `gmail-mcp-pessoal`, serviço `gmail-mcp`, domínio `https://gmail-mcp-production-c64a2b60.up.railway.app`,
  variáveis configuradas (chave de criptografia gerada aleatoriamente; `DATABASE_URL` com o papel restrito).
  **Deploy automático** a cada push na branch `main` (app da Railway instalado no GitHub; commits de quem não é membro do projeto na Railway esperam aprovação em Deployments). Alternativa manual: `railway up`.
- Supabase (core-ccl-prod): migrações `001` e `002` aplicadas. O papel `gmail_mcp_app` lê/escreve só as 6 tabelas de `gmail_mcp`
  e não tem acesso a nenhuma tabela de outro schema (verificado com `has_table_privilege`). Não precisa expor o schema na API REST.

`SEU_DOMINIO` abaixo = `https://gmail-mcp-production-c64a2b60.up.railway.app`.

### 2. Google Cloud — projeto, Gmail API, consentimento e credenciais

1. <https://console.cloud.google.com> → seletor de projetos → **Novo projeto** → nome `gmail-mcp-pessoal` → **Criar**. Selecione-o.
2. **APIs e serviços → Biblioteca** → busque **Gmail API** → **Ativar**.
3. **Google Auth Platform** (menu "APIs e serviços → Tela de permissão OAuth" leva para lá) → **Primeiros passos**:
   - *Informações do app*: nome `Gmail MCP pessoal`; e-mail de suporte: o seu.
   - *Público*: **Externo**.
   - *Dados de contato*: seu e-mail. Aceite a política → **Criar**.
4. **Acesso a dados** → **Adicionar ou remover escopos** → marque/cole:
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/gmail.modify`
   → **Atualizar** → **Salvar**. (Não adicione `https://mail.google.com/`.)
5. **Clientes** → **Criar cliente**:
   - Tipo: **Aplicativo da Web**; nome: `gmail-mcp-railway`.
   - **URIs de redirecionamento autorizados** (exatamente):
     - `SEU_DOMINIO/oauth/google/callback` — ex.: `https://gmail-mcp.up.railway.app/oauth/google/callback`
     - `http://localhost:3000/oauth/google/callback` (opcional, só para testar localmente)
   - Origens JavaScript: deixe vazio. → **Criar**. Copie **ID do cliente** e **Chave secreta** (guarde a chave num gerenciador de senhas).
6. **Público** → **Status de publicação** → **Publicar app** → confirmar **Em produção**.
   - **Por quê:** em *Teste*, o Google emite refresh token que **expira em 7 dias** quando há escopos do Gmail — você teria que reconectar toda semana.
   - Em *Produção* sem verificação, o app continua funcionando para uso pessoal: na hora de autorizar aparece
     **"O Google não verificou este app"** → clique **Avançado** → **Acessar Gmail MCP pessoal (não seguro)**.
     Apps não verificados têm limite de 100 usuários, irrelevante aqui. **Não** clique em "Preparar para verificação".
   - Se você já autorizou enquanto o app estava em *Teste*, **conecte de novo** depois de publicar: o token antigo mantém a validade de 7 dias.
   - ⚠️ Eu não consegui abrir as páginas oficiais do Google desta sessão para confirmar a regra vigente. Se o Console
     **impedir** a publicação sem verificação para `gmail.modify`, a alternativa é ficar em *Teste* (com
     `leonunezcampos@gmail.com` em **Usuários de teste**) e reconectar a cada 7 dias — o servidor detecta o token
     expirado e o claude.ai pede nova autorização. Me avise se isso acontecer.

### 3. Railway — colar as credenciais do Google

Em <https://railway.com> → projeto **gmail-mcp-pessoal** → serviço **gmail-mcp** → **Variables** → **New Variable**, crie:

- `GOOGLE_CLIENT_ID` = ID do cliente (termina em `.apps.googleusercontent.com`)
- `GOOGLE_CLIENT_SECRET` = chave secreta do cliente
- (opcional) `EMAIL_SIGNATURE` = sua assinatura (use `\n` para quebrar linha) e `SENDER_NAME` = nome do remetente

Clique em **Deploy** (ou "Apply changes") para reiniciar com as variáveis novas.

---

## Roteiro de teste no claude.ai

1. **Adicionar:** claude.ai → **Configurações → Conectores → Adicionar conector personalizado** →
   nome `Gmail pessoal`, URL `SEU_DOMINIO/mcp` → **Adicionar** → **Conectar**.
2. **Autorizar:** na tela do Google escolha **leonunezcampos@gmail.com** → *Avançado → Acessar (não seguro)* →
   **marque todas as caixas** (inclusive a do Gmail) → Continuar. Você volta ao Claude com o conector conectado.
   - Teste negativo (opcional): conectar com outra conta deve mostrar **"Acesso recusado"**.
3. **Permissões no Claude:** nas configurações do conector, deixe `send_message`, `reply`, `forward` e `send_draft`
   como **"Pedir aprovação"** (nunca "Sempre permitir"). É uma segunda trava além da descrição das ferramentas.
4. **Ferramentas** — numa conversa com o conector ativo, peça:

| # | Pedido ao Claude | Ferramenta | Esperado |
|---|---|---|---|
| 1 | "Liste meus marcadores do Gmail pessoal" | `list_labels` | Lista com INBOX, SENT e os seus |
| 2 | "Busque e-mails não lidos dos últimos 7 dias" | `search_threads` (`is:unread newer_than:7d`) | Conversas + `nextPageToken` |
| 3 | "Mostre a próxima página" | `search_threads` com `page_token` | Novas conversas |
| 4 | "Abra a conversa X" / "leia a mensagem completa" | `get_thread` / `get_message` | Corpo em texto, anexos listados |
| 5 | "Baixe o PDF anexo dessa mensagem e resuma" | `download_attachment` | Conteúdo (≤ 5 MB) ou link temporário |
| 6 | "Marque essa conversa como lida / não lida" | `mark_read` / `mark_unread` | Reflete no Gmail |
| 7 | "Aplique o marcador *X* e depois remova" | `label_thread` / `unlabel_thread` | Reflete no Gmail |
| 8 | "Arquive essa conversa" | `archive_thread` | Some da Caixa de entrada, continua em "Todos os e-mails" |
| 9 | "Crie um rascunho para leonunezcampos@gmail.com, assunto 'Teste ação ✅', corpo 'Olá, coração'" | `create_draft` | Rascunho no Gmail com acentos corretos |
| 10 | "Altere o corpo desse rascunho" / "liste meus rascunhos" / "mostre o rascunho" | `update_draft` / `list_drafts` / `get_draft` | — |
| 11 | "Envie esse rascunho" | `send_draft` | Claude mostra conteúdo, pede confirmação; retorna messageId/threadId |
| 12 | "Envie um e-mail para leonunezcampos@gmail.com com o anexo X" | `send_message` | Confirmação antes; e-mail chega com anexo e assinatura |
| 13 | "Responda a esse e-mail dizendo 'recebido'" (num e-mail que você mesmo enviou) | `reply` | Fica **na mesma conversa** no Gmail |
| 14 | "Encaminhe essa mensagem com anexo para leonunezcampos@gmail.com" | `forward` | Chega com os anexos originais |
| 15 | "Mova esse e-mail para a lixeira" | — | Claude responde que não há ferramenta para isso |

   **Envios só para o seu próprio endereço.** Para testar *responder a todos*, use uma conversa em que só você esteja.
5. **Auditoria:** no Supabase (core-ccl-prod) → SQL Editor → `select * from gmail_mcp.send_audit order by sent_at desc;`: uma linha por envio, com data/hora, `gmail_message_id`
   e `recipient_count` — sem endereços. Logs da Railway: só ferramenta, status e duração.
6. **Limites (opcional):** ponha `SEND_MAX_RECIPIENTS=1` e peça um envio para dois endereços seus → erro claro. Volte o valor.

## Como revogar o acesso

Do mais leve ao mais completo:

1. **claude.ai:** Configurações → Conectores → Gmail pessoal → **Desconectar** (ou remover).
2. **No servidor (tudo de uma vez):** revoga todos os tokens do Claude, revoga o refresh token no Google e apaga a credencial:
   ```bash
   railway link        # uma vez, para associar o CLI ao projeto
   railway run npm run revoke-all
   ```
   (Alternativa sem CLI: no SQL Editor do Supabase (core-ccl-prod), `update gmail_mcp.oauth_tokens set revoked_at = now() where revoked_at is null; delete from gmail_mcp.google_credentials;`)
3. **No Google:** <https://myaccount.google.com/permissions> → **Gmail MCP pessoal** → **Remover todo o acesso**.
   O servidor percebe na próxima chamada (`invalid_grant`), apaga a credencial e revoga os tokens do Claude.
4. **Emergência:** pause o serviço na Railway e/ou troque `GOOGLE_CLIENT_SECRET` (Google Cloud → Clientes → redefinir chave secreta).

---

## Segurança: o que o código garante

- **Só uma conta:** `src/auth/allowedAccount.ts` compara o e-mail do `id_token` (assinatura verificada com as chaves do Google,
  `aud` = seu client ID, `email_verified = true`) com `ALLOWED_GOOGLE_EMAIL`. Outra conta: página de erro, nada gravado e o token emitido pelo Google é revogado.
- **Ações proibidas:** `src/gmail/gateway.ts` é o único caminho até a Gmail API e só permite uma lista branca de métodos/caminhos.
  `trash`, `untrash`, `delete`, `batchDelete`, `settings/*` (filtros, encaminhamento, delegação, POP/IMAP, férias, sendAs),
  `import`, `insert`, criação/exclusão de marcadores e `modify` com `TRASH`/`SPAM` são recusados antes de qualquer requisição.
  IDs com `/`, `..` ou `%` também. Testes: `tests/forbidden.test.ts` (inclui varredura do código-fonte).
- **Sem exclusão de rascunhos:** não existe ferramenta nem rota de `drafts.delete`.
- **Tokens:** só hashes SHA-256 no banco; access de 1 h; refresh rotativo com detecção de reuso; códigos de 60 s de uso único;
  `resource` (RFC 8707) amarrado à URL do `/mcp`.
- **Refresh token do Google:** AES-256-GCM, IV aleatório, AAD = e-mail da conta; chave só em variável de ambiente.
- **Logs:** lista fechada de campos (`src/logger.ts`); corpo, assunto, endereços, nomes de arquivo e argumentos nunca são registrados.
- **Rate limiting:** `/mcp` 120/min por token; `/register` 20/h, `/token` 50/15 min, `/authorize` 100/15 min (SDK); callback e links de anexo limitados.
- **Envio:** `destructiveHint: true` + instrução de confirmação explícita; limite diário (reserva antes do envio, à prova de concorrência) e de destinatários; auditoria sem endereços.
