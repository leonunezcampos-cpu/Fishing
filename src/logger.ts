/**
 * Log estruturado SOMENTE com metadados técnicos.
 * Regra: nunca passar aqui corpo, assunto, endereços, nomes de arquivo ou argumentos de ferramentas.
 * Os campos aceitos são uma lista fechada; qualquer outro é descartado.
 */
const ALLOWED_FIELDS = new Set([
  'event',
  'tool',
  'status',
  'durationMs',
  'errorCode',
  'httpStatus',
  'method',
  'path',
  'clientId',
  'recipientCount',
  'gmailMessageId',
  'threadId',
  'reason',
]);

type LogFields = Record<string, string | number | boolean | undefined>;

function emit(level: 'info' | 'warn' | 'error', fields: LogFields) {
  if (process.env.LOG_SILENT === '1') return;
  const out: Record<string, unknown> = { ts: new Date().toISOString(), level };
  for (const [k, v] of Object.entries(fields)) {
    if (ALLOWED_FIELDS.has(k) && v !== undefined) out[k] = v;
  }
  const line = JSON.stringify(out);
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  info: (f: LogFields) => emit('info', f),
  warn: (f: LogFields) => emit('warn', f),
  error: (f: LogFields) => emit('error', f),
};

export const _test = { ALLOWED_FIELDS };
