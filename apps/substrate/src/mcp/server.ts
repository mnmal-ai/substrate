import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// Baked at build time — the bundler inlines package.json, so the bundled
// binary carries the literal value.
import pkg from '../../package.json' with { type: 'json' };
import { configureAgentAuth, getSubstrate, postSubstrate } from './http.js';
import {
  buildInstructions,
  buildLeanInstructions,
  type PendingWords,
  schemaOverview
} from './schema-overview.js';
import { READ_ONLY_TOOLS, resolveToolAllowlist, toolTable } from './tools.js';

/** The version the MCP server reports in its initialize serverInfo. */
export const MCP_SERVER_VERSION: string =
  typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';

export interface McpServerOptions {
  /**
   * Comma-separated tool names and presets to register (SUBSTRATE_MCP_TOOLS):
   * `core`, `lean` or `all`. Unset or blank means `core`.
   * Every registered definition rides along on every model call.
   */
  tools?: string;
  /** Sent to the client at initialize; clients put it in the agent's context. */
  instructions?: string;
  /** Whether a `lean` preset adds `ask`: true when the server runs substrate-nl. */
  nlAvailable?: boolean;
}

export function createMcpServer(endpoint: string, options: McpServerOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'substrate', version: MCP_SERVER_VERSION },
    options.instructions !== undefined ? { instructions: options.instructions } : undefined
  );

  const TOOLS = toolTable(endpoint);

  const allowed = resolveToolAllowlist(
    options.tools,
    TOOLS.map((t) => t.name),
    options.nlAvailable === true
  );
  for (const t of TOOLS) {
    if (!allowed.has(t.name)) continue;
    // Only a tool that changes nothing says so. Every other tool keeps the
    // protocol's default, which a host reads as able to overwrite or delete.
    const config = READ_ONLY_TOOLS.has(t.name)
      ? { ...t.config, annotations: { readOnlyHint: true } }
      : t.config;
    // biome-ignore lint/suspicious/noExplicitAny: config.inputSchema varies per tool
    server.registerTool(t.name, config as any, t.handler);
  }

  return server;
}

/** The overview for the session's instructions, or null when the server is slow or down. */
async function fetchOverview(endpoint: string): Promise<ReturnType<typeof schemaOverview> | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000).unref());
  const fetched = getSubstrate<Parameters<typeof schemaOverview>[0]>(
    endpoint,
    '/substrate/v1/federated-schema'
  ).then(schemaOverview, () => null);
  return Promise.race([fetched, timeout]);
}

/**
 * The caller's pending action words from a signed `act ?`, by namespace and type, without the `*`;
 * null when the call fails, is refused or takes over 5 s.
 */
export async function fetchPending(endpoint: string): Promise<PendingWords | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000).unref());
  const fetched = postSubstrate<{
    help?: { types?: Record<string, Record<string, string[]>> };
  }>(endpoint, '/substrate/v1/act', { sketch: '?' }).then(
    (r) => {
      const types = r.help?.types;
      if (types === undefined) return null;
      const pending: PendingWords = {};
      for (const [ns, byType] of Object.entries(types))
        for (const [type, names] of Object.entries(byType)) {
          const starred = names.filter((n) => n.endsWith('*')).map((n) => n.slice(0, -1));
          if (starred.length === 0) continue;
          pending[ns] = { ...pending[ns], [type]: starred };
        }
      return pending;
    },
    () => null
  );
  return Promise.race([fetched, timeout]);
}

/** Whether the server runs substrate-nl, so a lean session can offer `ask`; false on any failure or after 5 s. */
async function probeNl(endpoint: string): Promise<boolean> {
  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000).unref());
  const probed = getSubstrate<{ binary?: { coordinators?: Array<{ name?: unknown }> } }>(
    endpoint,
    '/substrate/v1/onboard'
  ).then(
    (r) => r.binary?.coordinators?.some((c) => c.name === 'substrate-nl') === true,
    () => false
  );
  return Promise.race([probed, timeout]);
}

/**
 * Boot the stdio MCP server. Resolves once the transport is connected; the
 * process keeps running until the host (Claude Code, etc.) closes stdio.
 */
export async function runMcp(): Promise<void> {
  const endpoint = process.env.SUBSTRATE_URL ?? 'http://localhost:3100';
  configureAgentAuth(process.env, endpoint);
  const lean = (process.env.SUBSTRATE_MCP_TOOLS ?? '').split(',').some((t) => t.trim() === 'lean');
  const [overview, pending] = await Promise.all([fetchOverview(endpoint), fetchPending(endpoint)]);
  const server = createMcpServer(endpoint, {
    ...(process.env.SUBSTRATE_MCP_TOOLS === undefined
      ? {}
      : { tools: process.env.SUBSTRATE_MCP_TOOLS }),
    instructions: lean
      ? buildLeanInstructions(overview, pending)
      : buildInstructions(overview, pending),
    nlAvailable: lean && (await probeNl(endpoint))
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
