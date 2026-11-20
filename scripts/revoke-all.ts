/**
 * Revogação total (botão de pânico): revoga todos os tokens emitidos ao Claude,
 * revoga o refresh token no Google e apaga a credencial cifrada do Supabase.
 * Uso: npm run revoke-all   (com as mesmas variáveis de ambiente do servidor)
 */
import { loadConfig } from '../src/config.js';
import { PostgresStore } from '../src/store/postgres.js';
import { RealGoogleOAuth } from '../src/auth/google.js';
import { decryptSecret } from '../src/crypto.js';

const config = loadConfig();
const store = new PostgresStore(config.DATABASE_URL!);
const google = new RealGoogleOAuth(config.GOOGLE_CLIENT_ID!, config.GOOGLE_CLIENT_SECRET!, config.googleRedirectUri, config.allowedEmail);

await store.revokeAllTokens();
console.log('✔ Tokens do Claude revogados.');
const cred = await store.getGoogleCredential(config.allowedEmail);
if (cred) {
  await google.revoke(decryptSecret(cred.secret, config.encryptionKey, cred.accountEmail));
  await store.deleteGoogleCredential(config.allowedEmail);
  console.log('✔ Refresh token do Google revogado no Google e apagado do banco.');
} else {
  console.log('• Nenhuma credencial do Google armazenada.');
}
await store.close();
