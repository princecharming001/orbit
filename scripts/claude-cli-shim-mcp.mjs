#!/usr/bin/env node
/**
 * The stdio MCP server scripts/claude-cli-shim.mjs hands the `claude` command line for one request: it lists the
 * request's client tools (read from the JSON file named on the command line, `[{ name, description, input_schema }]`)
 * and never answers a tools/call. The shim stops the command line as soon as the model calls one of them and returns
 * the call to the caller as a `tool_use` block, so the tool runs in the caller's own process, as it would with the API.
 *
 *   node scripts/claude-cli-shim-mcp.mjs <tools.json>
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const tools = JSON.parse(readFileSync(process.argv[2], 'utf8'));

function send(msg) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  // notifications (no id) need no answer
  if (id === undefined || id === null) return;
  switch (method) {
    case 'initialize':
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'orbit-shim', version: '1.0.0' },
        },
      });
    case 'ping':
      return send({ id, result: {} });
    case 'tools/list':
      return send({
        id,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            inputSchema: t.input_schema ?? { type: 'object', properties: {} },
          })),
        },
      });
    case 'tools/call':
      // never answered: the shim ends the run here and the caller runs the tool
      return;
    case 'resources/list':
      return send({ id, result: { resources: [] } });
    case 'prompts/list':
      return send({ id, result: { prompts: [] } });
    default:
      return send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
rl.on('close', () => process.exit(0));
