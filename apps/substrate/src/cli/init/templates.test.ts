import { OnnxEmbedder } from '@mnmal-ai/substrate-embedder';
import { RecallBootstrapConfigSchema } from '@mnmal-ai/substrate-recall/bootstrap';
import { describe, expect, it } from 'vitest';
import {
  dockerComposeTemplate,
  envBinaryTemplate,
  envDockerTemplate,
  pgInitSqlTemplate,
  pnpmWorkspaceTemplate,
  readmeTemplate,
  recallConfigTemplate,
  runtimePackageJsonTemplate
} from './templates.js';

const baseConfig = {
  store: 'postgres' as const,
  port: 3100,
  pgPort: 5433,
  plugins: ['cortext'],
  embedder: 'none' as const,
  substrateUrl: 'http://localhost:3100',
  tls: false,
  tlsCertPath: undefined,
  tlsKeyPath: undefined,
  pgPassword: 'TESTPASS',
  dbName: 'substrate_prod',
  composeName: 'substrate-test',
  substrateVersion: '2.8.6'
};

describe('envBinaryTemplate', () => {
  it('includes the postgres URL with embedded password when store=postgres', () => {
    const out = envBinaryTemplate(baseConfig);
    expect(out).toContain(
      'SUBSTRATE_DATABASE_URL=postgres://substrate:TESTPASS@127.0.0.1:5433/substrate_prod'
    );
  });

  it('uses SUBSTRATE_DATABASE_URL=memory when store=memory', () => {
    const out = envBinaryTemplate({ ...baseConfig, store: 'memory' });
    expect(out).toContain('SUBSTRATE_DATABASE_URL=memory');
    expect(out).not.toContain('postgres://');
  });

  it('sets SUBSTRATE_PLUGIN_DIR to . (runtime root — one realm for binary + plugins)', () => {
    expect(envBinaryTemplate(baseConfig)).toContain('SUBSTRATE_PLUGIN_DIR=.');
  });

  it('sets PORT', () => {
    expect(envBinaryTemplate({ ...baseConfig, port: 4000 })).toContain('PORT=4000');
  });

  it('never writes embedder env vars — nothing reads them (recall reads substrate-recall.config.json)', () => {
    for (const embedder of ['minilm', 'bge-base', 'ollama', 'none'] as const) {
      const out = envBinaryTemplate({ ...baseConfig, embedder });
      expect(out).not.toMatch(/SUBSTRATE_EMBEDDER|SUBSTRATE_OLLAMA/);
    }
  });

  it('does not emit an NL provider block (NL is a plugin concern, not part of vanilla init)', () => {
    const out = envBinaryTemplate(baseConfig);
    expect(out).not.toContain('SUBSTRATE_NL_PROVIDER');
    expect(out).not.toContain('ANTHROPIC_API_KEY');
  });

  it('does not put SUBSTRATE_URL in the server env (it is client-only)', () => {
    expect(envBinaryTemplate(baseConfig)).not.toContain('SUBSTRATE_URL');
  });

  it('embeds pgPort in SUBSTRATE_DATABASE_URL URL', () => {
    expect(envBinaryTemplate(baseConfig)).toContain('@127.0.0.1:5433/substrate_prod');
    expect(envBinaryTemplate({ ...baseConfig, pgPort: 5443 })).toContain(
      '@127.0.0.1:5443/substrate_prod'
    );
  });

  it('omits SUBSTRATE_TLS_* lines when tls=false', () => {
    const out = envBinaryTemplate(baseConfig);
    expect(out).not.toContain('SUBSTRATE_TLS_CERT_PATH=');
    expect(out).not.toContain('SUBSTRATE_TLS_KEY_PATH=');
  });

  it('emits SUBSTRATE_TLS_CERT_PATH + SUBSTRATE_TLS_KEY_PATH when tls=true', () => {
    const out = envBinaryTemplate({
      ...baseConfig,
      tls: true,
      tlsCertPath: '/etc/kernel/certs/fullchain.pem',
      tlsKeyPath: '/etc/kernel/certs/privkey.pem'
    });
    expect(out).toContain('SUBSTRATE_TLS_CERT_PATH=/etc/kernel/certs/fullchain.pem');
    expect(out).toContain('SUBSTRATE_TLS_KEY_PATH=/etc/kernel/certs/privkey.pem');
  });
});

describe('envDockerTemplate', () => {
  it('includes POSTGRES_PASSWORD literal', () => {
    expect(envDockerTemplate(baseConfig)).toContain('POSTGRES_PASSWORD=TESTPASS');
  });

  it('returns empty string when store=memory', () => {
    expect(envDockerTemplate({ ...baseConfig, store: 'memory' })).toBe('');
  });
});

describe('dockerComposeTemplate', () => {
  it('points every compose hint at .env.docker, which is where the scaffold puts the password', () => {
    const compose = dockerComposeTemplate(baseConfig);
    expect(compose).not.toMatch(/must be set in \.env\}/);
    expect(compose).not.toMatch(/run docker compose up -d/);
    expect(compose).toContain('docker compose --env-file .env.docker up -d');
  });

  it('keeps ": " out of compose required-variable messages, where it breaks the unquoted YAML', () => {
    const messages = [...dockerComposeTemplate(baseConfig).matchAll(/\$\{\w+:\?([^}]*)\}/g)].map(
      (m) => m[1] ?? ''
    );
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) expect(message).not.toContain(': ');
  });

  it('returns empty string when store=memory', () => {
    expect(dockerComposeTemplate({ ...baseConfig, store: 'memory' })).toBe('');
  });

  it('includes pgvector image when store=postgres', () => {
    expect(dockerComposeTemplate(baseConfig)).toContain('pgvector/pgvector:pg18');
  });

  it('mounts the data volume where PostgreSQL 18+ images expect it', () => {
    // The pg18 image refuses to start with a mount at /var/lib/postgresql/data.
    expect(dockerComposeTemplate(baseConfig)).toContain('./data/pg:/var/lib/postgresql\n');
  });

  it('binds postgres to 127.0.0.1:<pgPort>', () => {
    expect(dockerComposeTemplate(baseConfig)).toContain('127.0.0.1:5433:5432');
    expect(dockerComposeTemplate({ ...baseConfig, pgPort: 5443 })).toContain('127.0.0.1:5443:5432');
  });

  it('uses composeName from ctx, not a hardcoded value', () => {
    expect(dockerComposeTemplate(baseConfig)).toContain('name: substrate-test');
    expect(dockerComposeTemplate({ ...baseConfig, composeName: 'substrate-home' })).toContain(
      'name: substrate-home'
    );
  });

  // The backup sidecar ships commented out — present for the
  // operator to enable, absent from what compose actually starts.
  it('carries the backup sidecar commented out, never as a live service', () => {
    const out = dockerComposeTemplate(baseConfig);
    expect(out).toContain('#  postgres-backup:');
    expect(out).not.toMatch(/^\s{2}postgres-backup:/m);
  });

  // The package ships no ops/ docs or scripts, so the scaffold must not point at any.
  it('references no file outside the scaffold', () => {
    const outputs = [
      dockerComposeTemplate(baseConfig),
      readmeTemplate({ ...baseConfig, embedder: 'minilm' }),
      readmeTemplate({ ...baseConfig, embedder: 'ollama' })
    ];
    for (const out of outputs) {
      expect(out).not.toMatch(/ops\/|backup-loop\.sh/);
    }
  });
});

describe('runtimePackageJsonTemplate', () => {
  it('runtime package.json pins to the current major and includes the substrate binary', () => {
    const pkg = JSON.parse(runtimePackageJsonTemplate(baseConfig));
    // The binary is installed into the same tree as the plugins (one realm).
    expect(pkg.dependencies['@mnmal-ai/substrate']).toBeDefined();
    // No stale hardcoded ^2.7.1 — pin tracks the shipped version.
    for (const range of Object.values(pkg.dependencies) as string[]) {
      expect(range).not.toBe('^2.7.1');
    }
  });

  it('lists each plugin under dependencies', () => {
    const out = JSON.parse(runtimePackageJsonTemplate(baseConfig));
    expect(out.dependencies['@mnmal-ai/cortext']).toBeDefined();
  });

  it('ranges the cortext line on its own versions, not the substrate major', () => {
    // Pinning cortext at ^<substrate major> named a version that never exists, so a
    // default scaffold failed `pnpm install` with ERR_PNPM_NO_MATCHING_VERSION.
    const out = JSON.parse(
      runtimePackageJsonTemplate({
        ...baseConfig,
        plugins: ['cortext', 'substrate-nl'],
        substrateVersion: '7.14.0'
      })
    );
    expect(out.dependencies['@mnmal-ai/substrate-nl']).toBe('^7.0.0');
    expect(out.dependencies['@mnmal-ai/cortext']).toBe('^1.0.0-alpha.0');
  });

  it('pins to the current major version derived from substrateVersion', () => {
    const out = JSON.parse(
      runtimePackageJsonTemplate({
        ...baseConfig,
        plugins: ['substrate-nl'],
        substrateVersion: '3.1.4'
      })
    );
    expect(out.dependencies).toEqual({
      '@mnmal-ai/substrate': '^3.0.0',
      '@mnmal-ai/substrate-nl': '^3.0.0'
    });
  });

  it('ranges a prerelease binary from its own version, which ^<major>.0.0 would not match', () => {
    const out = JSON.parse(
      runtimePackageJsonTemplate({
        ...baseConfig,
        plugins: ['substrate-nl'],
        substrateVersion: '1.0.0-alpha.0'
      })
    );
    expect(out.dependencies['@mnmal-ai/substrate']).toBe('^1.0.0-alpha.0');
    expect(out.dependencies['@mnmal-ai/substrate-nl']).toBe('^1.0.0-alpha.0');
  });

  it('includes @mnmal-ai/substrate binary even when plugins=[]', () => {
    const out = JSON.parse(runtimePackageJsonTemplate({ ...baseConfig, plugins: [] }));
    expect(out.dependencies['@mnmal-ai/substrate']).toBeDefined();
    expect(Object.keys(out.dependencies)).toHaveLength(1);
  });
});

describe('readmeTemplate', () => {
  it('mentions docker compose for postgres mode', () => {
    expect(readmeTemplate(baseConfig)).toContain('docker compose --env-file .env.docker up -d');
  });

  it('renders the health check + SUBSTRATE_URL client note with the configured public URL', () => {
    const out = readmeTemplate({
      ...baseConfig,
      substrateUrl: 'https://peer.example.com:3110',
      tls: true
    });
    expect(out).toContain('curl -sfk https://peer.example.com:3110/health');
    expect(out).toContain('SUBSTRATE_URL=https://peer.example.com:3110');
    expect(out).toContain('**client** setting');
  });

  it('uses plain -sf (no -k) for an http URL', () => {
    expect(readmeTemplate(baseConfig)).toContain('curl -sf http://localhost:3100/health');
  });

  it('skips docker compose for memory mode', () => {
    expect(readmeTemplate({ ...baseConfig, store: 'memory' })).not.toContain('docker compose');
  });

  it('postgres README uses --env-file .env.docker for compose', () => {
    expect(readmeTemplate(baseConfig)).toContain('docker compose --env-file .env.docker up -d');
  });

  it('postgres README uses pnpm install (single root install)', () => {
    const out = readmeTemplate(baseConfig);
    expect(out).toContain('pnpm install');
    expect(out).not.toContain('--ignore-workspace');
  });

  it('postgres README runs substrate via node_modules/.bin/substrate serve', () => {
    expect(readmeTemplate(baseConfig)).toContain(
      'set -a && source .env && set +a && ./node_modules/.bin/substrate serve'
    );
  });

  it('memory README uses pnpm install then node_modules/.bin/substrate serve', () => {
    const out = readmeTemplate({ ...baseConfig, store: 'memory' });
    expect(out).toContain('pnpm install');
    expect(out).toContain('./node_modules/.bin/substrate serve');
  });

  // Postgres README says no backups are configured; memory mode
  // has no durable state to dump, so it says nothing.
  it('postgres README carries a Backups section saying none are configured', () => {
    expect(readmeTemplate(baseConfig)).toContain('## Backups');
    expect(readmeTemplate(baseConfig)).toContain('None are configured');
  });

  it('memory README carries no Backups section', () => {
    expect(readmeTemplate({ ...baseConfig, store: 'memory' })).not.toContain('## Backups');
  });
});

describe('pgInitSqlTemplate', () => {
  it('returns CREATE DATABASE for postgres mode', () => {
    expect(pgInitSqlTemplate(baseConfig)).toContain('CREATE DATABASE substrate_prod');
  });

  it('returns empty for memory mode', () => {
    expect(pgInitSqlTemplate({ ...baseConfig, store: 'memory' })).toBe('');
  });
});

describe('pnpmWorkspaceTemplate', () => {
  it('returns a minimal workspace declaring no packages', () => {
    const out = pnpmWorkspaceTemplate();
    expect(out).toContain('packages: []');
  });

  it('approves the native build scripts pnpm 11 would otherwise fail the install on', () => {
    const out = pnpmWorkspaceTemplate();
    expect(out).toMatch(/^allowBuilds:\n {2}msgpackr-extract: true\n {2}onnxruntime-node: true$/m);
  });
});

describe('recallConfigTemplate', () => {
  // What the scaffold writes has to be what the plugin accepts: the schema is
  // strict, and the onnx model name must be one OnnxEmbedder maps.
  it.each(['minilm', 'bge-base', 'ollama'] as const)(
    '%s parses under the recall schema',
    (mode) => {
      const text = recallConfigTemplate(mode, '/srv/rt');
      expect(text).not.toBeNull();
      const { embedder } = RecallBootstrapConfigSchema.parse(JSON.parse(text as string));
      expect(embedder?.kind).toBe(mode === 'ollama' ? 'ollama' : 'onnx');
      if (embedder?.kind === 'onnx') {
        expect(
          new OnnxEmbedder({ model: embedder.model, dimension: embedder.dimension }).dimension
        ).toBe(embedder.dimension);
        expect(embedder.cacheDir).toBe('/srv/rt/models');
      }
    }
  );

  it('none writes nothing', () => {
    expect(recallConfigTemplate('none', '/srv/rt')).toBeNull();
  });
});
