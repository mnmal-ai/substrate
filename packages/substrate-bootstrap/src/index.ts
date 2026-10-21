/**
 * @mnmal-ai/substrate-bootstrap — shared bootstrap helper for Substrate plugins.
 *
 * Every plugin's `bootstrap.ts` becomes a 5-line declaration via this helper:
 *
 *   // Coordinator (operator JSON config only)
 *   export const bootstrap = defineBootstrap.coordinator({
 *     schema: MyConfigSchema,
 *     build: (config) => createMyPlugin(config)
 *   });
 *
 *   // Kernel (operator JSON config PLUS host-built deps)
 *   export const bootstrap = defineBootstrap.kernel<MyConfig, MyHostDeps>({
 *     schema: MyConfigSchema,
 *     build: (config, hostDeps) => createMySubstrate({ ...config, ...hostDeps })
 *   });
 *
 * The helper handles parse → catch → invoke → return. The plugin owns its
 * config schema + factory (pure typed-config); the platform stays
 * plugin-agnostic. The schema is structural (`ConfigSchema`): a zod schema of
 * any version fits, as does any validator with the same `safeParse` shape.
 *
 * Coordinator vs substrate: coordinator plugins receive only operator JSON
 * config. Substrate plugins additionally receive a typed bag of platform-
 * built dependencies (sql handle, embedder, edges store, etc.) at invocation
 * time — those are always code-shaped and cannot live in JSON config.
 *
 * The architecturally correct path for substrate-supplied state is for the
 * substrate plugin to act on coordinator-contributed metadata (e.g.
 * substrate-recall walks `TypeInput.embed` and contributes postWrite hooks via
 * `contributePostWrites`) — NOT for the binary to post-attach extras to a
 * specific coordinator.
 */

import type { CoordinatorPlugin, KernelPlugin } from '@mnmal-ai/substrate-types';

/** One validation failure: where in the config it is, and what is wrong. */
export interface ConfigValidationIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

/** A failed parse's error. A zod error satisfies this shape. */
export interface ConfigValidationError {
  readonly issues: ReadonlyArray<ConfigValidationIssue>;
}

/**
 * The config schema seam: anything whose `safeParse` returns the parsed
 * config or a validation error. A zod schema of any version satisfies it.
 */
export interface ConfigSchema<TConfig> {
  safeParse(
    raw: unknown
  ): { success: true; data: TConfig } | { success: false; error: ConfigValidationError };
}

export interface CoordinatorBootstrapSpec<TConfig> {
  /** Schema for the operator-overridable config surface. */
  schema: ConfigSchema<TConfig>;
  /**
   * Plugin factory — receives parsed, defaults-applied, validated config.
   * Coordinators do not receive code-shaped extras (see the module doc).
   */
  build: (config: TConfig) => CoordinatorPlugin;
}

export type CoordinatorBootstrap = (rawConfig: Record<string, unknown>) => CoordinatorPlugin;

export interface KernelBootstrapSpec<TConfig, THostDeps> {
  /** Schema for the operator-overridable config surface. */
  schema: ConfigSchema<TConfig>;
  /**
   * Plugin factory — receives parsed, defaults-applied, validated config,
   * plus a typed bag of host-built dependencies the platform constructs and
   * supplies at invocation. Keep `THostDeps` plugin-specific.
   */
  build: (config: TConfig, hostDeps: THostDeps) => KernelPlugin;
}

export type KernelBootstrap<THostDeps> = (
  rawConfig: Record<string, unknown>,
  hostDeps: THostDeps
) => KernelPlugin;

export const defineBootstrap = {
  coordinator<TConfig>(spec: CoordinatorBootstrapSpec<TConfig>): CoordinatorBootstrap {
    return (raw: Record<string, unknown>): CoordinatorPlugin => {
      const result = spec.schema.safeParse(raw);
      if (!result.success) {
        throw new BootstrapConfigError(result.error);
      }
      return spec.build(result.data);
    };
  },

  kernel<TConfig, THostDeps>(
    spec: KernelBootstrapSpec<TConfig, THostDeps>
  ): KernelBootstrap<THostDeps> {
    return (raw: Record<string, unknown>, hostDeps: THostDeps): KernelPlugin => {
      const result = spec.schema.safeParse(raw);
      if (!result.success) {
        throw new BootstrapConfigError(result.error);
      }
      return spec.build(result.data, hostDeps);
    };
  }
} as const;

/**
 * Boot-time error thrown when a plugin's operator-supplied config fails its
 * declared schema. Caught by the loader, which re-throws with the offending
 * plugin name attached so operators see "<plugin> config invalid: <issues>"
 * rather than a bare validator dump.
 */
export class BootstrapConfigError extends Error {
  readonly validationError: ConfigValidationError;
  /** The same object as `validationError`. */
  readonly zodError: ConfigValidationError;

  constructor(validationError: ConfigValidationError) {
    const issues = validationError.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '<root>';
        return `  • ${path}: ${issue.message}`;
      })
      .join('\n');
    super(`Plugin config validation failed:\n${issues}`);
    this.name = 'BootstrapConfigError';
    this.validationError = validationError;
    this.zodError = validationError;
  }
}
