import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { MemoryStore } from './store/memory.js';
import { SupabaseStore } from './store/supabase.js';
import { FakeGoogleOAuth, RealGoogleOAuth } from './auth/google.js';
import { log } from './logger.js';
import type { FetchLike } from './gmail/gateway.js';

async function main() {
  const config = loadConfig();
  const store = config.STORE === 'memory' ? new MemoryStore() : new SupabaseStore(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!);
  const google = config.DEV_FAKE_GOOGLE
    ? new FakeGoogleOAuth(config.googleRedirectUri, config.allowedEmail)
    : new RealGoogleOAuth(config.GOOGLE_CLIENT_ID!, config.GOOGLE_CLIENT_SECRET!, config.googleRedirectUri, config.allowedEmail);

  let gmailFetch: FetchLike | undefined;
  if (config.GMAIL_MOCK) {
    const { MockGmail } = await import('./dev/mockGmail.js');
    gmailFetch = new MockGmail(config.allowedEmail).fetch;
  }

  const { app } = createApp({ config, store, google, gmailFetch });

  // Limpeza periódica de pedidos, códigos e tokens expirados.
  setInterval(() => store.cleanupExpired().catch(() => log.warn({ event: 'cleanup', status: 'error' })), 60 * 60 * 1000).unref();

  app.listen(config.PORT, () => {
    log.info({ event: 'started', status: config.NODE_ENV, reason: `porta ${config.PORT}; MCP em ${config.mcpUrl}` });
    if (config.DEV_FAKE_GOOGLE || config.GMAIL_MOCK) log.warn({ event: 'dev_mode', reason: 'Google e/ou Gmail SIMULADOS' });
  });
}

main().catch(e => {
  console.error('Falha ao iniciar:', e instanceof Error ? e.message : e);
  process.exit(1);
});
