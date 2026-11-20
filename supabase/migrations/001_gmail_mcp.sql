-- Servidor MCP do Gmail pessoal — esquema próprio, isolado do resto do projeto.
-- Rodar no SQL Editor do Supabase (ou via supabase db push).

create schema if not exists gmail_mcp;

-- Clientes OAuth registrados dinamicamente pelo claude.ai (RFC 7591)
create table if not exists gmail_mcp.oauth_clients (
  client_id     text primary key,
  client_name   text,
  redirect_uris text[] not null,
  metadata      jsonb not null,
  created_at    timestamptz not null default now()
);

-- Pedidos /authorize aguardando o retorno do Google (vida: 10 min)
create table if not exists gmail_mcp.oauth_pending (
  id                   text primary key,          -- state enviado ao Google
  client_id            text not null references gmail_mcp.oauth_clients(client_id) on delete cascade,
  redirect_uri         text not null,
  code_challenge       text not null,
  claude_state         text,
  resource             text,
  scopes               text[] not null default '{}',
  google_code_verifier text not null,
  expires_at           timestamptz not null
);

-- Códigos de autorização emitidos ao Claude (só o hash SHA-256; vida: 60 s; uso único)
create table if not exists gmail_mcp.oauth_codes (
  code_hash      text primary key,
  client_id      text not null references gmail_mcp.oauth_clients(client_id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null,
  resource       text,
  scopes         text[] not null default '{}',
  expires_at     timestamptz not null,
  used_at        timestamptz
);

-- Tokens emitidos ao Claude (só o hash SHA-256). Refresh com rotação e detecção de reuso por família.
create table if not exists gmail_mcp.oauth_tokens (
  token_hash text primary key,
  kind       text not null check (kind in ('access', 'refresh')),
  client_id  text not null references gmail_mcp.oauth_clients(client_id) on delete cascade,
  family_id  uuid not null,
  scopes     text[] not null default '{}',
  resource   text,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists oauth_tokens_family_idx on gmail_mcp.oauth_tokens (family_id);

-- Refresh token do Google, criptografado com AES-256-GCM (chave fora do banco)
create table if not exists gmail_mcp.google_credentials (
  account_email            text primary key,
  google_sub               text not null,
  refresh_token_ciphertext text not null,
  iv                       text not null,
  auth_tag                 text not null,
  key_version              int  not null default 1,
  scopes                   text not null,
  updated_at               timestamptz not null default now()
);

-- Auditoria de envios: sem endereços, assunto ou corpo
create table if not exists gmail_mcp.send_audit (
  id               uuid primary key default gen_random_uuid(),
  sent_at          timestamptz not null default now(),
  tool             text not null,
  status           text not null check (status in ('pending', 'sent', 'failed')),
  recipient_count  int  not null,
  gmail_message_id text,
  thread_id        text
);
create index if not exists send_audit_sent_at_idx on gmail_mcp.send_audit (sent_at);

-- RLS ligado e nenhuma política: só a service role (servidor) acessa.
alter table gmail_mcp.oauth_clients      enable row level security;
alter table gmail_mcp.oauth_pending      enable row level security;
alter table gmail_mcp.oauth_codes        enable row level security;
alter table gmail_mcp.oauth_tokens       enable row level security;
alter table gmail_mcp.google_credentials enable row level security;
alter table gmail_mcp.send_audit         enable row level security;

-- O schema precisa ser acessível à service role pela API REST.
grant usage on schema gmail_mcp to service_role;
grant all on all tables in schema gmail_mcp to service_role;
alter default privileges in schema gmail_mcp grant all on tables to service_role;
revoke all on schema gmail_mcp from anon, authenticated;
