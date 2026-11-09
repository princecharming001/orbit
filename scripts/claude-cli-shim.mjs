#!/usr/bin/env node
/**
 * A local stand-in for the Anthropic Messages API that answers through the `claude` command line, so the chat quality
 * bench (plan 28) runs on the developer's own Claude login instead of an API key. Only for hand-run benches.
 *
 *   node scripts/claude-cli-shim.mjs                      # listens on SHIM_PORT (default 8787)
 *   ORBIT_SIM_PROXY=http://localhost:8787 NODE_USE_ENV_PROXY=0 scripts/chat-baseline.sh <group>
 *
 * Every request is stateless: the messages are flattened into one transcript (roles kept, tool calls and results
 * written out), the request's system text becomes the system prompt, and its client tools are offered to the command
 * line through a stdio MCP server (scripts/claude-cli-shim-mcp.mjs) that never answers. As soon as the model calls one
 * of them the run is stopped and the call goes back as `tool_use` blocks (stop_reason tool_use), so the caller runs
 * its own tools exactly as with the API. Claude's web search maps to the command line's WebSearch, whose calls and
 * sources come back as server_tool_use / web_search_tool_result blocks. Structured output (output_config.format
 * json_schema) maps to --json-schema. Streaming requests get a synthesized SSE stream.
 *
 * Fidelity limits (compare arms run through the same path, never across paths):
 *   - the history is one flattened transcript in a single user turn, not real multi-turn messages with tool blocks
 *   - Claude Code adds its own small preamble and tool plumbing around the system prompt; no thinking blocks return
 *   - no prompt caching of the caller's own breakpoints, no compaction, no refusal fallbacks, no max_tokens
 *   - tools marked defer_loading turn on Claude Code's own MCP tool search for that request, which defers every
 *     client tool, not only the marked ones (Orbit sends none today)
 *   - WebSearch returns a summary of the results written by the command line, not the raw results and citations,
 *     and asks for a markdown "Sources:" list, which the shim takes off the end of the words written after a search
 *   - token counts are the command line's (its preamble included); WebSearch's own sub-request is not counted
 *
 * Env: CLAUDE_BIN (the command line; the one on PATH is too old for Opus 5.5), SHIM_PORT, SHIM_CONCURRENCY (3),
 * SHIM_MAX_TURNS (4), SHIM_TOOL_GRACE_MS (1500), SHIM_STATS (usage totals file), SHIM_DEBUG=1 (log prompts' sizes).
 * GET /stats returns the running totals; they are also written to SHIM_STATS after every request and on exit.
 * ANTHROPIC_API_KEY is removed from the command line's environment: only its own login is used.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = join(HERE, 'claude-cli-shim-mcp.mjs');
const CLAUDE_BIN =
  process.env.CLAUDE_BIN ||
  join(
    homedir(),
    'Library/Application Support/Claude/claude-code/2.1.317/91184d3d9ba3/claude.app/Contents/MacOS/claude',
  );
const PORT = Number(process.env.SHIM_PORT || 8787);
const CONCURRENCY = Math.max(1, Number(process.env.SHIM_CONCURRENCY || 3));
const MAX_TURNS = Number(process.env.SHIM_MAX_TURNS || 4);
const TOOL_GRACE_MS = Number(process.env.SHIM_TOOL_GRACE_MS || 1500);
const STATS_FILE = process.env.SHIM_STATS || join(tmpdir(), 'claude-cli-shim-stats.json');
const RUN_TIMEOUT_MS = 300_000;
/** A streaming request whose answer takes longer than this gets its headers early (with pings), so no client times out. */
const STREAM_COMMIT_MS = Number(process.env.SHIM_STREAM_COMMIT_MS || 60_000);
const DEBUG = !!process.env.SHIM_DEBUG;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MCP_PREFIX = 'mcp__orbit__';
const ROOT = mkdtempSync(join(tmpdir(), 'claude-cli-shim-'));

// ---- totals ----------------------------------------------------------------------------------------------------------

const stats = {
  started: new Date().toISOString(),
  requests: 0,
  ok: 0,
  errors: 0,
  toolUseReplies: 0,
  endTurnReplies: 0,
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  webSearches: 0,
  /** what the command line reports as the API-equivalent cost, for runs that reached their result event */
  reportedCostUsd: 0,
  secondsTotal: 0,
  byModel: {},
};

function saveStats() {
  try {
    writeFileSync(STATS_FILE, `${JSON.stringify({ ...stats, updated: new Date().toISOString() }, null, 2)}\n`);
  } catch (e) {
    console.error('[shim] could not write stats:', e.message);
  }
}

// ---- a small queue so only SHIM_CONCURRENCY command lines run at once ------------------------------------------------

let running = 0;
const waiting = [];
async function slot(fn) {
  if (running >= CONCURRENCY) await new Promise((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// ---- request → prompt ------------------------------------------------------------------------------------------------

function blocksOf(content) {
  if (content == null) return [];
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

function plainText(content) {
  return blocksOf(content)
    .map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : b.type === 'document' ? '[document]' : ''))
    .filter(Boolean)
    .join('\n');
}

function webResultsText(content) {
  if (!Array.isArray(content)) return `the search failed (${content?.error_code ?? 'error'})`;
  return content
    .filter((r) => r?.type === 'web_search_result')
    .map((r) => `- ${r.title || r.url} (${r.url})`)
    .join('\n');
}

/**
 * The messages as one transcript. A single plain user message (the simulated student, the judge) goes as it is, so
 * those calls are as close to the API as the command line allows.
 */
export function flatten(messages) {
  if (messages.length === 1 && messages[0].role === 'user') {
    const only = blocksOf(messages[0].content);
    if (only.every((b) => b.type === 'text')) return plainText(only);
  }
  const names = new Map();
  for (const m of messages)
    for (const b of blocksOf(m.content))
      if (b.type === 'tool_use' || b.type === 'server_tool_use') names.set(b.id, b.name);
  const parts = [];
  for (const m of messages) {
    const lines = [];
    for (const b of blocksOf(m.content)) {
      switch (b.type) {
        case 'text':
          if (b.text?.trim()) lines.push(b.text);
          break;
        case 'tool_use':
          lines.push(`(assistant called ${b.name} with ${JSON.stringify(b.input ?? {})})`);
          break;
        case 'server_tool_use':
          lines.push(
            b.name === 'web_search'
              ? `(assistant searched the web for ${JSON.stringify(b.input?.query ?? '')})`
              : `(assistant called ${b.name} with ${JSON.stringify(b.input ?? {})})`,
          );
          break;
        case 'web_search_tool_result':
          lines.push(`(web search results:\n${webResultsText(b.content)})`);
          break;
        case 'tool_result': {
          const body = typeof b.content === 'string' ? b.content : plainText(b.content);
          lines.push(`(result of ${names.get(b.tool_use_id) ?? 'a tool'}${b.is_error ? ', an error' : ''}: ${body})`);
          break;
        }
        case 'compaction':
          if (b.content) lines.push(`(summary of the earlier conversation: ${b.content})`);
          break;
        case 'image':
        case 'document':
          lines.push(`[the user attached a ${b.type}]`);
          break;
        default:
          // thinking, redacted thinking and anything else the model would not see as words
          break;
      }
    }
    if (!lines.length) continue;
    const results = blocksOf(m.content).every((b) => b.type === 'tool_result');
    const label =
      m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system note' : results ? 'tool results' : 'user';
    parts.push(`[${label}]\n${lines.join('\n')}`);
  }
  const last = messages.at(-1);
  const lastIsResults = last && blocksOf(last.content).some((b) => b.type === 'tool_result');
  return [
    'Below is the conversation so far between you (the assistant) and the user, with the tools you called and what they returned.',
    lastIsResults
      ? 'Continue your reply from the latest tool results.'
      : 'Write your next reply to the latest message.',
    'If the next step needs a tool, call it for real with your tool-calling ability: never write a call out as text, and never repeat a call whose result is already shown. Do not label your reply "assistant" and do not mention this transcript.',
    '',
    '<transcript>',
    parts.join('\n\n'),
    '</transcript>',
  ].join('\n');
}

function systemText(system) {
  if (!system) return '';
  return typeof system === 'string' ? system : plainText(system);
}

// ---- one command-line run ------------------------------------------------------------------------------------------

function cliEnv(toolSearch) {
  const env = { ...process.env, ENABLE_TOOL_SEARCH: toolSearch ? 'true' : 'false' };
  // the command line's own login only: never an API key, a token or a base URL from this shell
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'])
    delete env[k];
  return env;
}

function webResultsFrom(event, block) {
  const r = event.tool_use_result;
  const out = [];
  if (r && Array.isArray(r.results))
    for (const x of r.results)
      for (const c of Array.isArray(x?.content) ? x.content : [])
        if (c?.url) out.push({ type: 'web_search_result', url: c.url, title: c.title ?? c.url, encrypted_content: '', page_age: null });
  if (!out.length) {
    const text = typeof block.content === 'string' ? block.content : plainText(block.content);
    const m = text.match(/Links: (\[.*?\])\n/s);
    try {
      for (const c of m ? JSON.parse(m[1]) : [])
        if (c?.url) out.push({ type: 'web_search_result', url: c.url, title: c.title ?? c.url, encrypted_content: '', page_age: null });
    } catch {
      // no parsable sources
    }
  }
  return out;
}

/** Runs the command line for one request and returns the reply's content, stop reason and usage. */
function runCli(req) {
  const dir = mkdtempSync(join(ROOT, 'req-'));
  const cwd = join(dir, 'cwd');
  mkdirSync(cwd);
  const sysFile = join(dir, 'system.txt');
  writeFileSync(sysFile, req.system || 'You are a helpful assistant.');
  const args = [
    '-p',
    '--model',
    req.model,
    '--system-prompt-file',
    sysFile,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(MAX_TURNS),
    '--tools',
    req.web ? 'WebSearch' : '',
  ];
  const allowed = [];
  if (req.tools.length) {
    const toolsFile = join(dir, 'tools.json');
    const mcpFile = join(dir, 'mcp.json');
    writeFileSync(toolsFile, JSON.stringify(req.tools));
    writeFileSync(
      mcpFile,
      JSON.stringify({
        mcpServers: { orbit: { type: 'stdio', command: process.execPath, args: [MCP_SERVER, toolsFile] } },
      }),
    );
    args.push('--mcp-config', mcpFile);
    allowed.push('mcp__orbit');
  }
  if (req.web) allowed.push('WebSearch');
  if (allowed.length) args.push('--allowedTools', allowed.join(','));
  if (req.effort) args.push('--effort', req.effort);
  if (req.schema) args.push('--json-schema', JSON.stringify(req.schema));

  return new Promise((resolve) => {
    const p = spawn(CLAUDE_BIN, args, { cwd, env: cliEnv(req.toolSearch), stdio: ['pipe', 'pipe', 'pipe'] });
    const blocks = [];
    const webIds = new Map();
    const msgUsage = new Map();
    let result;
    let stderr = '';
    let done = false;
    let graceTimer;

    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      if (p.exitCode === null) {
        p.kill('SIGTERM');
        setTimeout(() => p.exitCode === null && p.kill('SIGKILL'), 2000).unref();
      }
      setTimeout(() => rmSync(dir, { recursive: true, force: true }), 3000).unref();
      resolve({ why, blocks, webIds, msgUsage, result, stderr });
    };
    const hardTimer = setTimeout(() => finish('timeout'), RUN_TIMEOUT_MS);

    createInterface({ input: p.stdout }).on('line', (line) => {
      if (done || !line.trim()) return;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        return;
      }
      if (e.type === 'assistant' && e.message) {
        if (e.message.id && e.message.usage) msgUsage.set(e.message.id, e.message.usage);
        for (const c of e.message.content ?? []) {
          if (c.type === 'text' && c.text) blocks.push({ type: 'text', text: c.text });
          else if (c.type === 'tool_use' && c.name === 'WebSearch') {
            const id = `srvtoolu_${c.id.replace(/^toolu_/, '')}`;
            webIds.set(c.id, id);
            blocks.push({ type: 'server_tool_use', id, name: 'web_search', input: { query: c.input?.query ?? '' } });
          } else if (c.type === 'tool_use' && c.name.startsWith(MCP_PREFIX)) {
            blocks.push({ type: 'tool_use', id: c.id, name: c.name.slice(MCP_PREFIX.length), input: c.input ?? {} });
            // parallel calls of the same message arrive one block at a time: wait a moment for the rest
            graceTimer ??= setTimeout(() => finish('tool_use'), TOOL_GRACE_MS);
          }
        }
      } else if (e.type === 'user' && e.message) {
        for (const c of blocksOf(e.message.content)) {
          if (c.type !== 'tool_result') continue;
          const srv = webIds.get(c.tool_use_id);
          if (srv) {
            const sources = webResultsFrom(e, c);
            blocks.push({
              type: 'web_search_tool_result',
              tool_use_id: srv,
              content: c.is_error && !sources.length ? { type: 'web_search_tool_result_error', error_code: 'unavailable' } : sources,
            });
          } else if (graceTimer) finish('tool_use');
        }
      } else if (e.type === 'result') {
        result = e;
        finish(graceTimer ? 'tool_use' : 'result');
      }
    });
    p.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    p.on('error', (err) => {
      stderr += String(err);
      finish('spawn_error');
    });
    p.on('close', () => finish('closed'));
    p.stdin.on('error', () => {});
    p.stdin.end(req.prompt);
  });
}

// ---- one Messages request ------------------------------------------------------------------------------------------

class ShimError extends Error {
  constructor(status, type, message) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

function parseRequest(body) {
  const toolChoice = body.tool_choice?.type;
  const all = toolChoice === 'none' ? [] : (body.tools ?? []);
  const tools = all
    .filter((t) => !t.type || t.type === 'custom')
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, defer: !!t.defer_loading }));
  const web = all.some((t) => typeof t.type === 'string' && t.type.startsWith('web_search'));
  let system = systemText(body.system);
  if (toolChoice === 'any' || toolChoice === 'tool')
    system += `\n\nYou must call ${toolChoice === 'tool' ? `the ${body.tool_choice.name} tool` : 'one of your tools'} now.`;
  // a per-message effort change (an empty system message with output_config, plan 37) wins over the request's own
  const perMessage = [...(body.messages ?? [])].reverse().find((m) => m?.output_config?.effort)?.output_config?.effort;
  const effort = perMessage ?? body.output_config?.effort;
  const format = body.output_config?.format;
  return {
    model: body.model,
    effort: EFFORTS.has(effort) ? effort : undefined,
    schema: format?.type === 'json_schema' ? format.schema : undefined,
    system,
    tools: tools.map(({ defer: _d, ...t }) => t),
    toolSearch: tools.some((t) => t.defer),
    web,
    prompt: flatten(body.messages ?? []),
  };
}

/** A trailing "Sources:" heading followed only by markdown links, one per line. */
const SOURCES_LIST = /\n*[*_#\s]*Sources:?[*_]*\s*\n(?:[ \t]*(?:[-*]|\d+\.)[ \t]+\[[^\]\n]*\]\([^)\n]+\)[^\n]*(?:\n|$))+\s*$/i;

function estimate(text) {
  return Math.ceil((text?.length ?? 0) / 4);
}

/** The reply as a Messages API message. */
async function answer(body) {
  const req = parseRequest(body);
  if (DEBUG)
    console.error(
      `[shim] ${req.model} effort=${req.effort ?? '-'} tools=${req.tools.length} web=${req.web} schema=${!!req.schema} system=${req.system.length}ch prompt=${req.prompt.length}ch`,
    );
  const run = await slot(() => runCli(req));
  let content = run.blocks;
  // a web search the run was stopped in the middle of has no result: leave it out
  const answered = new Set(content.filter((b) => b.type === 'web_search_tool_result').map((b) => b.tool_use_id));
  content = content.filter((b) => b.type !== 'server_tool_use' || answered.has(b.id));
  // the command line's WebSearch tells the model to end with a markdown list of its sources, which the API's web
  // search never asks for: that list is taken off the words written after a search
  let searched = false;
  content = content.flatMap((b) => {
    if (b.type === 'web_search_tool_result') searched = true;
    if (!searched || b.type !== 'text') return [b];
    const text = b.text.replace(SOURCES_LIST, '').trimEnd();
    return text ? [{ ...b, text }] : [];
  });
  if (req.schema) {
    const so = run.result?.structured_output;
    if (so !== undefined) content = [{ type: 'text', text: JSON.stringify(so) }];
    else content = content.filter((b) => b.type === 'text');
  }
  const hasToolUse = content.some((b) => b.type === 'tool_use');
  const hasText = content.some((b) => b.type === 'text' && b.text.trim());
  if (!hasToolUse && !hasText) {
    const msg = run.result?.result || run.result?.subtype || run.stderr.trim().split('\n').at(-1) || run.why;
    if (/limit|rate/i.test(String(msg))) throw new ShimError(429, 'rate_limit_error', `claude command line: ${msg}`);
    throw new ShimError(529, 'overloaded_error', `claude command line gave no answer (${run.why}): ${String(msg).slice(0, 300)}`);
  }
  if (!hasToolUse) content = content.filter((b) => b.type !== 'tool_use');

  // usage: the result event's totals when the run reached it, else each API message's last reported usage
  const u = run.result?.usage;
  let usage;
  if (u) {
    usage = {
      input_tokens: u.input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
    };
  } else {
    usage = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
    for (const x of run.msgUsage.values()) {
      usage.input_tokens += x.input_tokens ?? 0;
      usage.cache_read_input_tokens += x.cache_read_input_tokens ?? 0;
      usage.cache_creation_input_tokens += x.cache_creation_input_tokens ?? 0;
      usage.output_tokens += x.output_tokens ?? 0;
    }
    // a run stopped mid-stream reports a partial output count: never less than the words it wrote
    const written = content.map((b) => (b.type === 'text' ? b.text : JSON.stringify(b.input ?? ''))).join('');
    usage.output_tokens = Math.max(usage.output_tokens, estimate(written));
  }
  const webSearches = content.filter((b) => b.type === 'web_search_tool_result').length;
  usage.server_tool_use = { web_search_requests: webSearches };

  const cost = run.result?.total_cost_usd ?? 0;
  stats.inputTokens += usage.input_tokens;
  stats.cacheReadTokens += usage.cache_read_input_tokens;
  stats.cacheWriteTokens += usage.cache_creation_input_tokens;
  stats.outputTokens += usage.output_tokens;
  stats.webSearches += webSearches;
  stats.reportedCostUsd += cost;
  const m = (stats.byModel[req.model] ??= { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  m.requests++;
  m.input += usage.input_tokens;
  m.cacheRead += usage.cache_read_input_tokens;
  m.cacheWrite += usage.cache_creation_input_tokens;
  m.output += usage.output_tokens;
  if (hasToolUse) stats.toolUseReplies++;
  else stats.endTurnReplies++;

  return {
    id: `msg_shim_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    type: 'message',
    role: 'assistant',
    model: req.model,
    content,
    stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage,
  };
}

// ---- HTTP ------------------------------------------------------------------------------------------------------------

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** The finished message as the event stream the SDK's MessageStream accumulates. */
function writeStreamBody(res, msg, started) {
  if (!started)
    sse(res, 'message_start', {
      type: 'message_start',
      message: { ...msg, content: [], stop_reason: null, usage: { ...msg.usage, output_tokens: 1 } },
    });
  msg.content.forEach((b, index) => {
    if (b.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      // a sentence at a time, roughly as the API streams it
      for (const piece of b.text.match(/[^.!?\n]*[.!?\n]+\s*|[^.!?\n]+$/g) ?? [b.text])
        sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } });
    } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: b.type, id: b.id, name: b.name, input: {} },
      });
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) },
      });
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: b });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
  });
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: msg.stop_reason, stop_sequence: null },
    usage: msg.usage,
  });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function apiError(res, status, type, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type, message } }));
}

async function handleMessages(body, res, n) {
  const t0 = Date.now();
  const work = answer(body);
  let committed = false;
  let ping;
  let commitTimer;
  if (body.stream) {
    // a long answer: send the headers and message_start now, then pings, so the client keeps waiting
    commitTimer = setTimeout(() => {
      committed = true;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sse(res, 'message_start', {
        type: 'message_start',
        message: {
          id: `msg_shim_${Date.now().toString(36)}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 1 },
        },
      });
      ping = setInterval(() => sse(res, 'ping', { type: 'ping' }), 10_000);
    }, STREAM_COMMIT_MS);
  }
  try {
    const msg = await work;
    clearTimeout(commitTimer);
    clearInterval(ping);
    stats.ok++;
    const secs = (Date.now() - t0) / 1000;
    stats.secondsTotal += secs;
    const tools = msg.content.filter((b) => b.type === 'tool_use').map((b) => b.name);
    const web = msg.content.filter((b) => b.type === 'server_tool_use').length;
    console.error(
      `[shim] #${n} ${body.model} ${body.stream ? 'stream' : 'json'} -> ${msg.stop_reason}${tools.length ? ` (${tools.join(', ')})` : ''}${web ? ` web×${web}` : ''} ${secs.toFixed(1)}s`,
    );
    if (body.stream) {
      if (!committed) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      writeStreamBody(res, msg, committed);
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(msg));
    }
  } catch (e) {
    clearTimeout(commitTimer);
    clearInterval(ping);
    stats.errors++;
    const status = e instanceof ShimError ? e.status : 500;
    const type = e instanceof ShimError ? e.type : 'api_error';
    console.error(`[shim] #${n} ${body.model} failed ${status}: ${e.message} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (committed) {
      sse(res, 'error', { type: 'error', error: { type, message: e.message } });
      res.end();
    } else apiError(res, status, type, e.message);
  } finally {
    saveStats();
  }
}

const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ...stats, running, queued: waiting.length }, null, 2));
  }
  if (req.method !== 'POST') return apiError(res, 404, 'not_found_error', 'Only POST /v1/messages is served here.');
  let raw = '';
  req.on('data', (d) => {
    raw += d;
  });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return apiError(res, 400, 'invalid_request_error', 'The body is not JSON.');
    }
    if (path.endsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: estimate(JSON.stringify(body)) }));
    }
    if (!path.endsWith('/v1/messages')) return apiError(res, 404, 'not_found_error', `No route for ${path}.`);
    stats.requests++;
    handleMessages(body, res, stats.requests);
  });
});

function shutdown() {
  saveStats();
  console.error(`[shim] totals written to ${STATS_FILE}`);
  rmSync(ROOT, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// loopback only, both families, so http://localhost works whichever one the client resolves first
server.on('error', (e) => {
  console.error(`[shim] cannot listen on ${PORT}: ${e.message}`);
  process.exit(1);
});
const v6 = http.createServer(server.listeners('request')[0]);
v6.on('error', () => {});
v6.listen(PORT, '::1');
server.listen(PORT, '127.0.0.1', () => {
  console.error(`[shim] Messages API on http://localhost:${PORT} via ${CLAUDE_BIN} (concurrency ${CONCURRENCY})`);
  console.error(`[shim] stats: GET /stats, and ${STATS_FILE}`);
});
