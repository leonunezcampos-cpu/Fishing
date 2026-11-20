import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { MemoryStore } from './store/memory.js';
import { PostgresStore } from './store/postgres.js';
import { FakeGoogleOAuth, RealGoogleOAuth, UnconfiguredGoogleOAuth, type GoogleOAuth } from './auth/google.js';
import { log } from './logger.js';
import type { FetchLike } from './gmail/gateway.js';

async function main() {
  const config = loadConfig();
  const store = config.STORE === 'memory' ? new MemoryStore() : new PostgresStore(config.DATABASE_URL!);
  let google: GoogleOAuth;
  if (config.DEV_FAKE_GOOGLE) google = new FakeGoogleOAuth(config.googleRedirectUri, config.allowedEmail);
  else if (config.googleConfigured)
    google = new RealGoogleOAuth(config.GOOGLE_CLIENT_ID!, config.GOOGLE_CLIENT_SECRET!, config.googleRedirectUri, config.allowedEmail);
  else {
    google = new UnconfiguredGoogleOAuth();
    log.warn({ event: 'config', reason: 'GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET ausentes: autorização desativada' });
  }

  let gmailFetch: FetchLike | undefined;
  if (config.GMAIL_MOCK) {
    const { MockGmail } = await import('./dev/mockGmail.js');
    gmailFetch = new MockGmail(config.allowedEmail).fetch;
  }

  if (store instanceof PostgresStore) {
    try {
      await store.ping();
      log.info({ event: 'db', status: 'ok' });
    } catch (e) {
      // Não derruba o servidor: o healthcheck mostra o problema.
      log.error({ event: 'db', status: 'error', errorCode: (e as { code?: string }).code ?? (e as Error).name, reason: String((e as Error).message).slice(0, 200) });
    }
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
