/** A banner: fixed text per output kind. */
export interface TsdownBanner {
  js?: string;
  css?: string;
  dts?: string;
}

/**
 * The tsdown config the helpers build. Declared here rather than as tsdown's
 * `UserConfig` so the published types name no tsdown version; it is
 * assignable to the consumer's own `UserConfig`.
 */
export interface TsdownConfig {
  entry: string[] | Record<string, string>;
  format: 'esm'[];
  platform: 'node' | 'neutral';
  target: string;
  fixedExtension: boolean;
  sourcemap: boolean;
  clean: boolean;
  minify: boolean;
  outDir: string;
  dts: boolean;
  deps?: {
    neverBundle?: (string | RegExp)[];
    alwaysBundle?: (string | RegExp)[];
  };
  shims?: boolean;
  banner?: TsdownBanner;
}

/**
 * Bare-name Node builtins. CJS deps (ws, postgres, pino) `require('events')`
 * unprefixed; bin-mode bundling collapses them inline, then the bundler's
 * inner require shim throws at runtime. Listing them as external keeps these
 * imports as Node-resolved at runtime instead of bundled.
 */
const NODE_BARE_BUILTINS = [
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'stream/web',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib'
];

export interface BinTsdownOptions {
  entry: Record<string, string>;
  banner?: TsdownBanner;
  clean?: boolean;
  /** Extra never-bundle patterns, merged after NODE_BARE_BUILTINS. */
  neverBundle?: (string | RegExp)[];
  /** Force-bundle patterns (deps.alwaysBundle). */
  alwaysBundle?: (string | RegExp)[];
}

export function defineBinTsdown({
  entry,
  banner,
  clean = true,
  neverBundle = [],
  alwaysBundle
}: BinTsdownOptions): TsdownConfig {
  return {
    entry,
    format: ['esm'],
    platform: 'node',
    target: 'node26',
    // tsdown defaults to .mjs/.d.mts even under type:module — pin .js so
    // package.json main/types/exports/bin paths resolve.
    fixedExtension: false,
    sourcemap: false,
    clean,
    minify: false,
    outDir: 'dist',
    dts: false,
    deps: {
      neverBundle: [...NODE_BARE_BUILTINS, ...neverBundle],
      ...(alwaysBundle !== undefined ? { alwaysBundle } : {})
    },
    shims: true,
    ...(banner !== undefined ? { banner } : {})
  };
}

export interface LibTsdownOptions {
  entry?: string[] | Record<string, string>;
  /** Never-bundle patterns — mapped to tsdown's `deps.neverBundle`. */
  external?: (string | RegExp)[];
  platform?: 'node' | 'neutral';
  banner?: TsdownBanner;
}

export function defineLibTsdown({
  entry = ['src/index.ts'],
  external,
  platform = 'node',
  banner
}: LibTsdownOptions = {}): TsdownConfig {
  return {
    entry,
    format: ['esm'],
    platform,
    target: 'node26',
    // See defineBinTsdown — keep emitted extensions at .js/.d.ts.
    fixedExtension: false,
    sourcemap: false,
    clean: true,
    minify: false,
    outDir: 'dist',
    dts: false,
    ...(external !== undefined ? { deps: { neverBundle: external } } : {}),
    ...(banner !== undefined ? { banner } : {})
  };
}
