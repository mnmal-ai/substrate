import { checkbox, confirm, input, select } from '@inquirer/prompts';
import { type EmbedderMode, type InitConfig, parsePort } from './config.js';
import { defaultPluginsForPersona, KNOWN_PLUGINS, type Persona } from './plugins.js';

function validPort(v: string): true | string {
  try {
    parsePort('port', v);
    return true;
  } catch (err) {
    return (err as Error).message;
  }
}

export async function runRepl(seed: InitConfig): Promise<InitConfig> {
  process.stdout.write('substrate init — interactive setup. Ctrl-C to abort.\n\n');

  const targetDir =
    seed.targetDir ??
    (await input({
      message: 'Target directory:',
      default: './substrate-runtime',
      validate: (v) => v.length > 0 || 'required'
    }));

  let plugins: string[];
  if (seed.plugins !== undefined) {
    plugins = [...seed.plugins];
  } else {
    const persona = await select<Persona | 'custom'>({
      message: 'Plugin set:',
      choices: [
        { name: 'minimal — no app plugins (the bundled ones only)', value: 'minimal' },
        { name: 'agent-context — cortext, an agent coordination store', value: 'agent-context' },
        { name: 'full — every known mnmal-ai plugin', value: 'full' },
        { name: 'custom — pick individually', value: 'custom' }
      ]
    });

    if (persona === 'custom') {
      plugins = await checkbox({
        message: 'Plugins to install:',
        choices: KNOWN_PLUGINS.map((p) => ({
          name: `${p.name} — ${p.description}`,
          value: p.name,
          checked: false
        }))
      });
      const extra = await input({
        message: 'Additional plugins (csv of npm names, blank for none):',
        default: ''
      });
      if (extra.trim().length > 0) {
        plugins.push(
          ...extra
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        );
      }
    } else {
      plugins = [...defaultPluginsForPersona(persona)];
    }
  }

  const store =
    seed.store ??
    (await select<'postgres' | 'memory'>({
      message: 'Storage backend:',
      choices: [
        { name: 'postgres — bundled compose (recommended)', value: 'postgres' },
        { name: 'memory — ephemeral, data vanishes on restart', value: 'memory' }
      ]
    }));

  const port =
    seed.port ??
    parsePort(
      'port',
      await input({ message: 'Listen port:', default: '3100', validate: (v) => validPort(v) })
    );

  const pgPort =
    seed.pgPort ??
    parsePort(
      'pg-port',
      await input({
        message: 'Postgres port (host-side):',
        default: '5433',
        validate: (v) => validPort(v)
      })
    );

  const embedder =
    seed.embedder ??
    (await select<EmbedderMode>({
      message: 'Semantic recall embedder:',
      default: 'minilm',
      choices: [
        { name: 'minilm — all-MiniLM-L6-v2, in-process (recommended)', value: 'minilm' },
        { name: 'bge-base — bge-base-en-v1.5, in-process, slower and stronger', value: 'bge-base' },
        { name: 'ollama — bge-m3 via local Ollama', value: 'ollama' },
        { name: 'none — no semantic recall', value: 'none' }
      ]
    }));

  const tls =
    seed.tls ||
    (await confirm({
      message: 'Terminate TLS in the binary (HTTPS)?',
      default: false
    }));

  let tlsCertPath: string | undefined;
  let tlsKeyPath: string | undefined;
  if (tls) {
    tlsCertPath =
      seed.tlsCertPath ??
      (await input({
        message: 'TLS cert path (PEM):',
        default: `${process.env.HOME ?? '~'}/.substrate/certs/fullchain.pem`,
        validate: (v) => v.length > 0 || 'required'
      }));
    tlsKeyPath =
      seed.tlsKeyPath ??
      (await input({
        message: 'TLS key path (PEM):',
        default: `${process.env.HOME ?? '~'}/.substrate/certs/privkey.pem`,
        validate: (v) => v.length > 0 || 'required'
      }));
  }

  const substrateUrl =
    seed.substrateUrl ??
    (await input({
      message: 'Public URL clients (MCP/CLI) use to reach this instance:',
      default: `${tls ? 'https' : 'http'}://localhost:${port}`,
      validate: (v) => v.length > 0 || 'required'
    }));

  const force =
    seed.force ||
    (await confirm({
      message: `Scaffold to ${targetDir}? (Will refuse if it already exists unless you confirm overwrite.)`,
      default: true
    }));

  return {
    targetDir,
    store,
    port,
    pgPort,
    plugins,
    embedder,
    substrateUrl,
    tls,
    tlsCertPath,
    tlsKeyPath,
    yes: true,
    force
  };
}
