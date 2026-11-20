import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform(v => v === '1' || v?.toLowerCase() === 'true');

const intWithDefault = (def: number) =>
  z
    .string()
    .optional()
    .transform(v => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int().positive());

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: intWithDefault(3000),

  /** URL pública do servidor, sem barra no final. Ex.: https://gmail-mcp.up.railway.app */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),

  /** Única conta Google autorizada. */
  ALLOWED_GOOGLE_EMAIL: z.string().email().default('leonunezcampos@gmail.com'),
  /** Nome exibido no remetente (opcional). */
  SENDER_NAME: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  /** 32 bytes em base64 (npm run gen-key). Criptografa o refresh token do Google e assina links. */
  TOKEN_ENCRYPTION_KEY: z.string().optional(),

  STORE: z.enum(['postgres', 'memory']).default('postgres'),
  /** postgresql://gmail_mcp_app.<ref>:<senha>@<pooler>:6543/postgres — papel restrito ao schema gmail_mcp. */
  DATABASE_URL: z.string().optional(),

  ACCESS_TOKEN_TTL_SECONDS: intWithDefault(3600),
  REFRESH_TOKEN_TTL_SECONDS: intWithDefault(30 * 24 * 3600),

  SEND_DAILY_LIMIT: intWithDefault(50),
  SEND_MAX_RECIPIENTS: intWithDefault(20),
  SEND_TIMEZONE: z.string().default('America/Sao_Paulo'),
  /** Assinatura em texto. Use \n para quebra de linha. Vazia = sem assinatura. */
  EMAIL_SIGNATURE: z.string().optional(),
  /** Assinatura em HTML (opcional; se ausente, deriva da versão em texto). */
  EMAIL_SIGNATURE_HTML: z.string().optional(),

  /** Anexos até este tamanho voltam inline; acima, link temporário. */
  ATTACHMENT_INLINE_MAX_BYTES: intWithDefault(5 * 1024 * 1024),
  /** Tamanho máximo absoluto de anexo para download. */
  ATTACHMENT_MAX_BYTES: intWithDefault(25 * 1024 * 1024),
  DOWNLOAD_LINK_TTL_SECONDS: intWithDefault(600),

  MCP_RATE_LIMIT_PER_MINUTE: intWithDefault(120),

  /** Permite redirect_uri em localhost no registro dinâmico (MCP Inspector). */
  ALLOW_LOCALHOST_REDIRECTS: bool,
  /** Desenvolvimento: substitui o Google por um login falso. Proibido em produção. */
  DEV_FAKE_GOOGLE: bool,
  /** Desenvolvimento: Gmail simulado em memória. Proibido em produção. */
  GMAIL_MOCK: bool,
});

export type Config = ReturnType<typeof loadConfig>;

export const CLAUDE_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.modify',
] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.parse(env);
  const isProd = parsed.NODE_ENV === 'production';
  const baseUrl = parsed.PUBLIC_BASE_URL.replace(/\/+$/, '');

  if (isProd && (parsed.DEV_FAKE_GOOGLE || parsed.GMAIL_MOCK || parsed.STORE === 'memory')) {
    throw new Error('DEV_FAKE_GOOGLE, GMAIL_MOCK e STORE=memory são proibidos com NODE_ENV=production');
  }
  if (isProd && !baseUrl.startsWith('https://')) {
    throw new Error('PUBLIC_BASE_URL precisa ser https em produção');
  }
  if (parsed.STORE === 'postgres' && !parsed.DATABASE_URL) {
    throw new Error('DATABASE_URL é obrigatória com STORE=postgres');
  }

  let encryptionKey: Buffer;
  if (parsed.TOKEN_ENCRYPTION_KEY) {
    encryptionKey = Buffer.from(parsed.TOKEN_ENCRYPTION_KEY, 'base64');
    if (encryptionKey.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY deve ter 32 bytes em base64');
  } else if (!isProd && parsed.STORE === 'memory') {
    encryptionKey = Buffer.alloc(32, 7); // só para desenvolvimento em memória
  } else {
    throw new Error('TOKEN_ENCRYPTION_KEY é obrigatória');
  }

  const unescape = (s?: string) => (s ? s.replace(/\\n/g, '\n') : undefined);

  return {
    ...parsed,
    isProd,
    baseUrl,
    mcpUrl: `${baseUrl}/mcp`,
    allowedEmail: parsed.ALLOWED_GOOGLE_EMAIL.toLowerCase(),
    encryptionKey,
    signatureText: unescape(parsed.EMAIL_SIGNATURE)?.trim() || undefined,
    signatureHtml: parsed.EMAIL_SIGNATURE_HTML?.trim() || undefined,
    googleRedirectUri: `${baseUrl}/oauth/google/callback`,
    googleConfigured: !!(parsed.GOOGLE_CLIENT_ID && parsed.GOOGLE_CLIENT_SECRET),
  };
}
