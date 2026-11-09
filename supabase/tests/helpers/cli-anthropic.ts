/**
 * Answers an Anthropic Messages request through the local `claude` command line (the developer's own Claude login)
 * instead of the API key, so a bench can run without spending from Orbit's key. Only for hand-run benches: the reply
 * has the Messages API shape the SDK expects, with the text (or the structured output as JSON) as one text block.
 *
 * Fidelity: the command line adds a small preamble and runs structured output through its own tool, so absolute
 * scores and token counts differ a little from the API; compare arms run through the same path, never across paths.
 * CLAUDE_BIN points at a newer command line than the one on PATH (Opus 5.5 needs 2.1.280 or newer).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Block {
  type: string;
  text?: string;
}
interface Body {
  model: string;
  system?: string | Block[];
  messages: { role: string; content: string | Block[] }[];
  output_config?: { effort?: string; format?: { type: string; schema?: unknown } };
}

const EMPTY_DIR = mkdtempSync(join(tmpdir(), 'orbit-cli-bench-'));

function text(c: string | Block[] | undefined): string {
  if (!c) return '';
  if (typeof c === 'string') return c;
  return c
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n');
}

export interface CliUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}
export const cliTotals: CliUsage & { calls: number } = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  calls: 0,
};

/** Runs one request; `override` swaps the model or effort (the bench's arm), applied by the caller's rule. */
export async function cliMessages(
  body: Body,
  override: { model?: string; effort?: string } = {},
): Promise<Response> {
  const model = override.model ?? body.model;
  const effort = override.effort ?? body.output_config?.effort;
  const schema =
    body.output_config?.format?.type === 'json_schema' ? body.output_config.format.schema : undefined;
  const prompt = body.messages
    .map((m) => (body.messages.length > 1 ? `${m.role}:\n` : '') + text(m.content))
    .join('\n\n');
  const args = [
    '-p',
    prompt,
    '--model',
    model,
    '--system-prompt',
    text(body.system) || 'You are a helpful assistant.',
    '--tools',
    '',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--exclude-dynamic-system-prompt-sections',
    '--output-format',
    'json',
  ];
  if (effort) args.push('--effort', effort);
  if (schema) args.push('--json-schema', JSON.stringify(schema));

  if (process.env.CLI_BENCH_DEBUG)
    console.error('cli call', model, effort, 'schema', !!schema, 'prompt', prompt.length);
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await run(args);
    let j: {
      is_error?: boolean;
      result?: string;
      structured_output?: unknown;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    try {
      j = JSON.parse(out);
    } catch {
      if (process.env.CLI_BENCH_DEBUG) console.error('claude cli unparsable:', out.slice(0, 800));
      continue;
    }
    if (j.is_error) {
      if (process.env.CLI_BENCH_DEBUG) console.error('claude cli error:', out.slice(0, 800));
      continue;
    }
    const u = j.usage ?? {};
    cliTotals.calls++;
    cliTotals.input += u.input_tokens ?? 0;
    cliTotals.cacheRead += u.cache_read_input_tokens ?? 0;
    cliTotals.cacheWrite += u.cache_creation_input_tokens ?? 0;
    cliTotals.output += u.output_tokens ?? 0;
    const answer =
      schema && j.structured_output !== undefined ? JSON.stringify(j.structured_output) : (j.result ?? '');
    return new Response(
      JSON.stringify({
        id: `msg_cli_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: answer }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: u.input_tokens ?? 0,
          output_tokens: u.output_tokens ?? 0,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'claude cli failed' } }),
    {
      status: 500,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(process.env.CLAUDE_BIN || 'claude', args, {
      cwd: EMPTY_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), 300_000);
    p.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}
