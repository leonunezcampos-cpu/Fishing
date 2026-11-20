import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '../src/logger.js';

describe('logger só com metadados', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('descarta campos fora da lista (corpo, assunto, destinatários, argumentos)', () => {
    vi.stubEnv('LOG_SILENT', '0');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log.info({ event: 'tool_call', tool: 'send_message', status: 'ok', durationMs: 5, subject: 'Segredo', body: 'texto', to: 'a@b.com', args: '{}' } as any);
    const line = JSON.parse(spy.mock.calls[0][0] as string);
    expect(Object.keys(line).sort()).toEqual(['durationMs', 'event', 'level', 'status', 'tool', 'ts']);
    expect(JSON.stringify(line)).not.toMatch(/Segredo|texto|a@b\.com/);
    spy.mockRestore();
  });
});
