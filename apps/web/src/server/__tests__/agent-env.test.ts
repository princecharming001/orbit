import { describe, expect, it } from 'vitest';
import type { Db } from '../../../../../supabase/functions/_shared/db.ts';
import { agentEnvWithSecrets } from '../../../../../supabase/functions/_shared/services.ts';

const fakeDb = (stored: Record<string, string>, asked: string[][]): Db =>
  ({
    sql: async (_s: TemplateStringsArray, ...values: unknown[]) => {
      const names = values[0] as string[];
      asked.push(names);
      return names.map((n) => ({ n, v: stored[n] ?? null }));
    },
  }) as unknown as Db;

describe('agent env with stored secrets', () => {
  it('takes a key from the secrets table when the function has none, and the function secret when it has one', async () => {
    const asked: string[][] = [];
    const env = await agentEnvWithSecrets(
      (n) => (n === 'UNIPILE_API_KEY' ? 'from-env' : undefined),
      fakeDb({ ORBIT_ANTHROPIC_API_KEY: 'stored-claude', UNIPILE_API_KEY: 'stored-unipile' }, asked),
    );
    expect(env.anthropicKey).toBe('stored-claude');
    expect(env.unipileKey).toBe('from-env');
    expect(env.exaKey).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toContain('UNIPILE_API_KEY');
  });

  it('falls back to the environment alone without a database', async () => {
    const env = await agentEnvWithSecrets((n) => (n === 'EXA_API_KEY' ? 'k' : undefined), undefined);
    expect(env.exaKey).toBe('k');
    expect(env.anthropicKey).toBeUndefined();
  });
});
