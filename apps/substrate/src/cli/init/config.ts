export type StoreMode = 'memory' | 'postgres';
/**
 * `bge-base` is the default, in-process with no service: the model the fleet
 * runs. `minilm` is smaller and faster to embed on CPU, also in-process.
 * `ollama` hands embedding to a local Ollama running bge-base-en-v1.5.
 */
export type EmbedderMode = 'minilm' | 'bge-base' | 'ollama' | 'none';

export const EMBEDDER_MODES: readonly EmbedderMode[] = ['bge-base', 'minilm', 'ollama', 'none'];

export interface InitConfig {
  targetDir: string | undefined;
  store: StoreMode | undefined;
  port: number | undefined;
  pgPort: number | undefined;
  plugins: string[] | undefined;
  embedder: EmbedderMode | undefined;
  /** Public URL clients (MCP/CLI) use to reach this instance. Rendered into the README. */
  substrateUrl: string | undefined;
  tls: boolean;
  tlsCertPath: string | undefined;
  tlsKeyPath: string | undefined;
  yes: boolean;
  force: boolean;
}

const KNOWN_FLAGS = new Set([
  'yes',
  'force',
  'plugins',
  'store',
  'port',
  'pg-port',
  'embedder',
  'substrate-url',
  'tls',
  'tls-cert-path',
  'tls-key-path'
]);

export function parsePort(flag: string, value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || n < 1 || n > 65535) {
    throw new Error(`--${flag} must be a positive integer port (1-65535), got: ${value}`);
  }
  return n;
}

export function parseArgs(argv: string[]): InitConfig {
  const config: InitConfig = {
    targetDir: undefined,
    store: undefined,
    port: undefined,
    pgPort: undefined,
    plugins: undefined,
    embedder: undefined,
    substrateUrl: undefined,
    tls: false,
    tlsCertPath: undefined,
    tlsKeyPath: undefined,
    yes: false,
    force: false
  };

  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      if (config.targetDir === undefined) config.targetDir = arg;
      continue;
    }
    const eqIndex = arg.indexOf('=');
    const flag = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex);
    const value = eqIndex === -1 ? '' : arg.slice(eqIndex + 1);
    if (!KNOWN_FLAGS.has(flag)) {
      throw new Error(`unknown flag --${flag}`);
    }
    switch (flag) {
      case 'yes':
        config.yes = true;
        break;
      case 'force':
        config.force = true;
        break;
      case 'plugins':
        config.plugins = value
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        break;
      case 'store':
        if (value !== 'memory' && value !== 'postgres') {
          throw new Error(`--store must be memory|postgres, got: ${value}`);
        }
        config.store = value;
        break;
      case 'port':
        config.port = parsePort('port', value);
        break;
      case 'pg-port':
        config.pgPort = parsePort('pg-port', value);
        break;
      case 'tls':
        config.tls = true;
        break;
      case 'tls-cert-path':
        config.tlsCertPath = value;
        break;
      case 'tls-key-path':
        config.tlsKeyPath = value;
        break;
      case 'embedder':
        if (!isEmbedderMode(value)) {
          throw new Error(`--embedder must be ${EMBEDDER_MODES.join('|')}, got: ${value}`);
        }
        config.embedder = value;
        break;
      case 'substrate-url':
        config.substrateUrl = value;
        break;
    }
  }

  if (config.tls && (config.tlsCertPath === undefined || config.tlsKeyPath === undefined)) {
    throw new Error('--tls requires both --tls-cert-path and --tls-key-path');
  }

  return config;
}

function isEmbedderMode(value: string): value is EmbedderMode {
  return (EMBEDDER_MODES as readonly string[]).includes(value);
}
