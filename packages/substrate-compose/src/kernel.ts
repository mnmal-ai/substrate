/**
 * Substrate-tier composition, shared by the substrate binary and any host that
 * composes its own server. Before this lived only in the binary, so a
 * self-composing host got none of the substrate tier: no plugin migrations
 * (substrate-recall's salience columns went missing and every vector search failed
 * silently), no filter operators unless hand-registered, and no
 * `onKernelReady` (so per-boot reconcilers such as substrate-recall's vector
 * realign never ran).
 *
 * `composeKernelPlugins` is the binary's implementation, unchanged: tracked
 * migrations, then filter operators, kernel routes, MCP tools, and finally
 * `onKernelReady` once every plugin has registered. `composeKernel`
 * wraps it with defaults a host needs: postgres migration tracking and the
 * shared filter-operator registry.
 */

import { getExtensionOperator, registerExtensionOperator } from '@mnmal-ai/substrate-core';
import type {
  FilterOperatorDef,
  HttpHandler,
  HttpMethod,
  KernelLifecycleContext,
  KernelMigrationContext,
  KernelPlugin,
  KernelRouteClaim,
  McpToolRegistration
} from '@mnmal-ai/substrate-types';
import type { AuthConfig } from './auth.js';
import { withAuth } from './compose/auth-middleware.js';
import { withRequestContext } from './routes/helpers.js';

/**
 * Mount a plugin's kernel route under `/substrate/v1/`, applying the capability gate
 * the claim asks for.
 *
 * Kernel routes mount outside `compose()`, so they do not inherit its
 * `gate(...)` wrapper; this applies it instead, and stamps the post-trust
 * `clientIp` and `authEnabled` the route's policy checks need.
 */
export function mountKernelRoute(
  server: { route(method: HttpMethod, path: string, handler: HttpHandler): void },
  claim: KernelRouteClaim,
  auth: AuthConfig | null,
  trustedProxies: Set<string> = new Set()
): void {
  // `'public'` is the only way past the gate, and it has to be written down:
  // an absent capability must not read as a deliberate opt-out.
  const handler =
    claim.capability !== 'public' && auth !== null
      ? withAuth(claim.handler, auth, claim.capability)
      : claim.handler;
  server.route(
    claim.method,
    `/substrate/v1/${claim.path}`,
    withRequestContext(handler, trustedProxies, auth !== null)
  );
}

export interface KernelComposeContext {
  /**
   * SQL handle for postgres-backed deployments; null on memory. Threaded
   * into each migration's apply / rollback.
   */
  sql: unknown | null;
  /** Store layout, supplied by the host; threaded into each migration's context. */
  layout: KernelMigrationContext['layout'];
  /** Structured metric sink. */
  metric: (name: string, payload?: unknown) => void;
  /** Register a kernel-level HTTP route (collision = throw). */
  registerKernelRoute: (claim: KernelRouteClaim) => void;
  /** Register an MCP tool with the global tool registry. */
  registerMcpTool: (tool: McpToolRegistration) => void;
  /**
   * Register a where-clause filter operator with the engine. `name` is the
   * Record key from `KernelPlugin.filterOperators`.
   */
  registerFilterOperator: (name: string, op: FilterOperatorDef) => void;
  /** Mark a migration as applied (idempotent in production; wraps actual SQL). */
  applyMigration: (pluginName: string, migrationId: string) => Promise<void>;
  /**
   * Return the set of migration IDs already applied for a given plugin.
   * Used by composeKernelPlugins to skip already-applied migrations.
   * Returns an empty set for memory-backed deployments.
   */
  getAppliedMigrationIds: (pluginName: string) => Promise<Set<string>>;
  /**
   * Namespaces declared by the coordinator plugins that were loaded. Passed
   * through to `onKernelReady` so a substrate plugin can reconcile against
   * the CONFIGURED namespace instead of a literal baked in at migration time.
   * Optional so existing callers (and tests composing throwaway plugins) need
   * not supply it; absent means none.
   */
  coordinatorNamespaces?: readonly string[];
  /**
   * Attribution for the above — which coordinator declared each namespace.
   * Forwarded only when supplied, so `undefined` reaches the plugin as
   * "this host does not attribute" rather than being flattened to `[]`.
   */
  coordinatorNamespacesByPlugin?: readonly { plugin: string; namespace: string }[];
  /** `KernelLifecycleContext.background`; true when absent. */
  background?: boolean;
}

export async function composeKernelPlugins(
  plugins: KernelPlugin[],
  ctx: KernelComposeContext
): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.migrations !== undefined) {
      const applied = await ctx.getAppliedMigrationIds(plugin.name);
      for (const migration of plugin.migrations) {
        if (applied.has(migration.id)) {
          ctx.metric('kernel.migration_skipped', { plugin: plugin.name, id: migration.id });
          continue;
        }
        await migration.apply({ sql: ctx.sql, layout: ctx.layout, metric: ctx.metric });
        await ctx.applyMigration(plugin.name, migration.id);
      }
    }
    if (plugin.filterOperators !== undefined) {
      for (const [name, op] of Object.entries(plugin.filterOperators)) {
        ctx.registerFilterOperator(name, op);
      }
    }
    if (plugin.kernelRoutes !== undefined) {
      for (const route of plugin.kernelRoutes) {
        ctx.registerKernelRoute(route);
      }
    }
    if (plugin.mcpTools !== undefined) {
      for (const tool of plugin.mcpTools) {
        ctx.registerMcpTool(tool);
      }
    }
  }
  // onKernelReady fires AFTER every plugin has registered, not after each
  // individual plugin — gives plugins a chance to observe each other's
  // registrations before doing post-register priming.
  for (const plugin of plugins) {
    if (plugin.onKernelReady !== undefined) {
      const lifecycleCtx: KernelLifecycleContext = {
        lifecycle: 'kernel',
        sql: ctx.sql,
        coordinatorNamespaces: ctx.coordinatorNamespaces ?? [],
        ...(ctx.coordinatorNamespacesByPlugin !== undefined
          ? { coordinatorNamespacesByPlugin: ctx.coordinatorNamespacesByPlugin }
          : {}),
        background: ctx.background ?? true,
        metric: ctx.metric
      };
      await plugin.onKernelReady(lifecycleCtx);
    }
  }
}

/**
 * The SQL a migration tracker needs: postgres.js's `unsafe(query, params)`
 * satisfies it, so this package takes no postgres dependency.
 */
export interface KernelSql {
  unsafe(query: string, params?: unknown[]): PromiseLike<unknown>;
}

/** Postgres-backed migration tracking in `kernel_migrations`, keyed by (plugin, id). */
export interface KernelMigrationTracking {
  ensure(): Promise<void>;
  getAppliedMigrationIds(pluginName: string): Promise<Set<string>>;
  recordMigrationApplied(pluginName: string, migrationId: string): Promise<void>;
}

/** Tracking against `sql`; every call is a no-op (nothing applied) when `sql` is null. */
export function kernelMigrationTracking(sql: KernelSql | null): KernelMigrationTracking {
  return {
    async ensure() {
      if (sql === null) return;
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS kernel_migrations (
          plugin_name TEXT NOT NULL,
          migration_id TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (plugin_name, migration_id)
        )
      `);
    },
    async getAppliedMigrationIds(pluginName) {
      if (sql === null) return new Set<string>();
      const rows = (await sql.unsafe(
        'SELECT migration_id FROM kernel_migrations WHERE plugin_name = $1',
        [pluginName]
      )) as Array<{ migration_id: string }>;
      return new Set(rows.map((r) => r.migration_id));
    },
    async recordMigrationApplied(pluginName, migrationId) {
      if (sql === null) return;
      await sql.unsafe(
        `INSERT INTO kernel_migrations (plugin_name, migration_id)
         VALUES ($1, $2) ON CONFLICT (plugin_name, migration_id) DO NOTHING`,
        [pluginName, migrationId]
      );
    }
  };
}

/** Register into the shared extension-operator registry the engine's validator reads. Throws on a duplicate. */
export function registerSharedFilterOperator(name: string, op: FilterOperatorDef): void {
  if (getExtensionOperator(name) !== undefined) {
    throw new Error(`Filter operator '${name}' already registered`);
  }
  registerExtensionOperator(name, op);
}

export interface ComposeKernelOptions {
  /** postgres.js handle (or any `KernelSql`); null on memory-backed deployments. */
  sql: KernelSql | null;
  /** Store layout; `null` on memory-backed deployments. */
  layout: KernelMigrationContext['layout'];
  metric?: (name: string, payload?: unknown) => void;
  /** Defaults to the shared registry the engine validates where-clauses against. */
  registerFilterOperator?: (name: string, op: FilterOperatorDef) => void;
  /**
   * Where kernel routes go. Without one, a plugin that claims a route makes
   * composition throw: a route silently not mounted is the failure this
   * module exists to remove.
   */
  registerKernelRoute?: (claim: KernelRouteClaim) => void;
  /** Without one, MCP tools are recorded as a metric and not exposed. */
  registerMcpTool?: (tool: McpToolRegistration) => void;
  coordinatorNamespaces?: readonly string[];
  coordinatorNamespacesByPlugin?: readonly { plugin: string; namespace: string }[];
  /** `KernelLifecycleContext.background`; true when absent. */
  background?: boolean;
}

/**
 * Compose substrate plugins the way the substrate binary does: ensure migration
 * tracking, apply each plugin's unapplied migrations, register its filter
 * operators / kernel routes / MCP tools, then run every `onKernelReady`.
 * Call once at boot, before composing coordinators.
 */
export async function composeKernel(
  plugins: KernelPlugin[],
  opts: ComposeKernelOptions
): Promise<void> {
  const tracking = kernelMigrationTracking(opts.sql);
  await tracking.ensure();
  const metric = opts.metric ?? (() => {});
  await composeKernelPlugins(plugins, {
    sql: opts.sql,
    layout: opts.layout,
    metric,
    registerFilterOperator: opts.registerFilterOperator ?? registerSharedFilterOperator,
    registerKernelRoute:
      opts.registerKernelRoute ??
      ((claim) => {
        throw new Error(
          `kernel plugin claims kernel route /substrate/v1/${claim.path}, but no registerKernelRoute was supplied`
        );
      }),
    registerMcpTool:
      opts.registerMcpTool ??
      ((tool) => metric('kernel.mcp_tool_not_exposed', { name: tool.name })),
    getAppliedMigrationIds: (name) => tracking.getAppliedMigrationIds(name),
    applyMigration: (name, id) => tracking.recordMigrationApplied(name, id),
    ...(opts.coordinatorNamespaces !== undefined
      ? { coordinatorNamespaces: opts.coordinatorNamespaces }
      : {}),
    ...(opts.coordinatorNamespacesByPlugin !== undefined
      ? { coordinatorNamespacesByPlugin: opts.coordinatorNamespacesByPlugin }
      : {}),
    ...(opts.background !== undefined ? { background: opts.background } : {})
  });
}
