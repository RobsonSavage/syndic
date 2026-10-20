import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// "noisy <marker>" fills the stderr pipe before the handshake, as a chatty server would. Every byte is
// written (partial writes and EAGAIN are retried) and the total is recorded in <marker> afterwards.
if (process.argv[2] === 'noisy') {
  const total = 1024 * 1024;
  const chunk = Buffer.alloc(16 * 1024, 'x');
  let written = 0;
  while (written < total) {
    try { written += writeSync(2, chunk, 0, Math.min(chunk.length, total - written)); } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  writeFileSync(process.argv[3], String(written));
}
const server = new Server({ name: 'extra', version: '1' }, { capabilities: { tools: {} } });
const schema = { type: 'object', properties: { text: { type: 'string' }, path: { type: 'string' } } };
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'echo', description: 'Echo text.', inputSchema: schema, annotations: { readOnlyHint: true, idempotentHint: false } },
  { name: 'wipe', description: 'Declared as changing state.', inputSchema: schema, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: 'secret', description: 'Must stay hidden.', inputSchema: schema },
  { name: 'read_text', description: 'Read a file relative to the working directory, as a real reader would.', inputSchema: schema },
  // Names that also exist on every object.
  { name: 'constructor', description: 'Echo text.', inputSchema: schema },
  { name: 'toString', description: 'Echo text.', inputSchema: schema },
] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const args = request.params.arguments ?? {};
  if (request.params.name === 'read_text') {
    try { return { content: [{ type: 'text', text: readFileSync(resolve(process.cwd(), String(args.path)), 'utf8') }] }; } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `read failed: ${error.code}` }] };
    }
  }
  return { content: [{ type: 'text', text: `${request.params.name}:${args.text ?? ''}` }] };
});
await server.connect(new StdioServerTransport());
