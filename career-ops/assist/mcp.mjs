// mcp.mjs — the same hybrid-RAG toolset, exposed as MCP so any chat app can drive it.
//
// WHY MCP ON TOP OF THE EXISTING SERVICE: the Chrome side panel runs our own agent loop against
// free models. Over MCP, the *client's* model (Claude, ChatGPT, Codex) does the reasoning and
// these tools do the retrieval — a strictly better split, because the retrieval is the part
// that is hard to replicate and the reasoning is the part those clients are already good at.
// The panel keeps working unchanged; this is an additional front door on the same tools.
//
// "Hybrid" is literal: search_career_ops is local BM25 over ~3,700 chunks with no network call,
// while web_search / fetch_url / get_linkedin_post / evaluate_job reach out live. A client can
// use either half or both in one turn.
//
// SINGLE SOURCE OF TRUTH: the tools are NOT redefined here. TOOL_SCHEMAS in tools.mjs is the one
// definition, converted to zod below. Two hand-maintained copies of fourteen tool signatures
// would disagree within a week, and the disagreement would be silent.
//
// Stateless transport: one server + transport per request, so there is no session to expire and
// no reconnect dance when a client idles. Same shape as linkedin-mcp and health-mcp.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { TOOL_SCHEMAS, runTool, ragIndexStats } from './tools.mjs';
import { tokenEqual } from './auth.mjs';

/** JSON Schema (the OpenRouter tool format) -> a zod shape the MCP SDK accepts. */
function zodShape(params = {}) {
  const shape = {};
  const required = new Set(params.required || []);
  for (const [name, spec] of Object.entries(params.properties || {})) {
    let t;
    switch (spec.type) {
      case 'number': t = z.number(); break;
      case 'boolean': t = z.boolean(); break;
      case 'array': t = z.array(spec.items?.type === 'number' ? z.number() : z.string()); break;
      default:
        // An enum stays an enum so the client sees the allowed values rather than a free string.
        t = Array.isArray(spec.enum) && spec.enum.length ? z.enum(spec.enum) : z.string();
    }
    if (spec.description) t = t.describe(spec.description);
    shape[name] = required.has(name) ? t : t.optional();
  }
  return shape;
}

// MCP wants text content. Objects go back as pretty JSON — chat clients read that fine and it
// keeps every field addressable, rather than flattening to prose the model then has to re-parse.
const asContent = (v) => ({
  content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }],
});

export function buildServer({ root }) {
  const s = new McpServer({ name: 'career-copilot', version: '1.0.0' });

  for (const t of TOOL_SCHEMAS) {
    const { name, description, parameters } = t.function;
    s.tool(name, description, zodShape(parameters), async (args) => {
      const result = await runTool(root, name, args || {});
      return asContent(result);
    });
  }

  // Not in TOOL_SCHEMAS because the panel's agent never needs it, but a chat client connecting
  // cold does: it answers "what do you actually have?" without burning a search to find out.
  s.tool('index_status',
    'What is in the local career-ops index right now: how many documents of each kind are searchable. Use this to see the scope of what search_career_ops covers.',
    {},
    async () => asContent({
      ...ragIndexStats(root),
      note: 'jd = saved job descriptions; report = past evaluations with scores; application = tracked applications; profile = CV, targeting and writing. New documents are picked up automatically within ~5s of being added.',
    }));

  return s;
}

/**
 * POST /mcp handler.
 * Auth accepts an Authorization header, x-api-key, or ?token= in the URL — the URL form is the one that
 * matters, because most connector dialogs (ChatGPT's included) expose no header field at all.
 */
export function createMcpHandler({ root, token }) {
  return async function handleMcp(req, res, bodyRaw) {
    const authz = req.headers.authorization || '';
    const urlToken = new URL(req.url, 'http://127.0.0.1').searchParams.get('token') || '';
    const provided = authz.startsWith('Bearer\u0020') ? authz.slice(7) : (req.headers['x-api-key'] || urlToken);
    if (!token || !provided || !tokenEqual(provided, token)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer\u0020realm="career-copilot"' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: valid token required' }, id: null }));
    }

    const server = buildServer({ root });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });

    let body;
    if (bodyRaw) { try { body = JSON.parse(bodyRaw); } catch { /* let the transport return a proper JSON-RPC error */ } }
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
