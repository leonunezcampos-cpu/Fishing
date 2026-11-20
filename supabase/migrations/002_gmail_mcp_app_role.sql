-- Papel de login dedicado ao servidor: só usa o schema gmail_mcp.
-- A senha é gerada fora do banco; aqui vai só o verificador SCRAM-SHA-256 (substitua o placeholder).
create role gmail_mcp_app with login noinherit nocreatedb nocreaterole nobypassrls
  connection limit 10
  password 'SCRAM-SHA-256$<iteracoes>:<salt>$<storedkey>:<serverkey>';

grant usage on schema gmail_mcp to gmail_mcp_app;
grant select, insert, update, delete on all tables in schema gmail_mcp to gmail_mcp_app;
alter default privileges in schema gmail_mcp grant select, insert, update, delete on tables to gmail_mcp_app;

-- RLS está ligado nas tabelas: política que libera tudo só para este papel.
do $$
declare t text;
begin
  foreach t in array array['oauth_clients','oauth_pending','oauth_codes','oauth_tokens','google_credentials','send_audit'] loop
    execute format('create policy gmail_mcp_app_all on gmail_mcp.%I for all to gmail_mcp_app using (true) with check (true)', t);
  end loop;
end $$;

alter role gmail_mcp_app set search_path = gmail_mcp;
alter role gmail_mcp_app set statement_timeout = '15s';
