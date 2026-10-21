/**
 * serve/boot-report.ts — startup banner block.
 *
 * Says the effective posture out loud: store, coordinators, auth, TLS,
 * idempotency. An operator who believed they had enabled something has no
 * other signal.
 */

import type { CoordinatorPlugin, Dataset, KernelPlugin } from '@mnmal-ai/substrate-types';
import type { Sql } from 'postgres';
import { knobsBanner, listeningBanner, memoryStoreBanner, noPluginsBanner } from './banners.js';
import type { ParsedConfig } from './config.js';
import { redactStoreSpec } from './wiring.js';

export interface BootInfo {
  address: string;
  port: number;
}

export function reportBoot(args: {
  config: ParsedConfig;
  info: BootInfo;
  storeSql: Sql | null;
  substrateNamespaceDataset: Dataset | null;
  coordinators: CoordinatorPlugin[];
  kernel: KernelPlugin[];
  pluginDir: string | null;
}): void {
  const { config, info, storeSql, substrateNamespaceDataset, coordinators, kernel, pluginDir } =
    args;
  process.stdout.write(listeningBanner(info.address, info.port, config.tls !== null));
  process.stdout.write(`store: ${redactStoreSpec(config.storeSpec)}\n`);
  if (config.storeSpec === 'memory') {
    process.stdout.write(memoryStoreBanner(config.memoryByDefault));
  }
  process.stdout.write(
    substrateNamespaceDataset !== null
      ? `_system: pg-backed\n`
      : `_system: memory-backed (keys ephemeral)\n`
  );
  if (coordinators.length > 0) {
    process.stdout.write(`coordinators: ${coordinators.map((p) => p.name).join(', ')}\n`);
  }
  if (kernel.length > 0) {
    process.stdout.write(`kernel: ${kernel.map((p) => p.name).join(', ')}\n`);
  }
  if (pluginDir !== null) {
    process.stdout.write(`plugin-dir: ${pluginDir}\n`);
  }
  if (coordinators.length === 0 && kernel.length === 0) {
    process.stdout.write(noPluginsBanner(pluginDir));
  }
  if (config.bridges.length > 0) {
    process.stdout.write(`bridges: ${config.bridges.map((b) => b.ns).join(', ')}\n`);
  }
  if (config.auth !== null) {
    // The count is FILE-registry descriptors only. Keys registered with
    // `substrate-admin register` live in the database and are loaded separately,
    // so a low number here is not a failed registration.
    const fileKeys = config.auth.keys.length;
    const source = fileKeys === 0 ? 'database-registered keys only' : `${fileKeys} file key(s)`;
    process.stdout.write(`auth: enabled, mode=${config.auth.mode ?? 'required'} (${source})\n`);
    // Say the EFFECTIVE interval, not whether the variable was set — an
    // explicit value silently outlives a changed default.
    const reprime = config.keyReprimeIntervalMs;
    // Source read from the knob report, not recomputed — one answer, whether
    // it is asked here, in the block below, or over `GET /substrate/v1/config`.
    const reprimeSource = ` (${config.knobs.keyReprimeIntervalMs?.source ?? 'default'})`;
    process.stdout.write(
      reprime === null
        ? `key cache: reprime off${reprimeSource}\n`
        : `key cache: reprime every ${reprime}ms${reprimeSource}\n`
    );
  } else {
    // Say it out loud: an operator who believed they had enabled auth has no
    // other signal.
    process.stdout.write('auth: DISABLED — all requests are anonymous\n');
  }
  if (config.tls !== null) {
    process.stdout.write(`tls: enabled${config.tls.ca !== undefined ? ' (with CA chain)' : ''}\n`);
  }
  if (config.idempotency.disabled) {
    process.stdout.write(`idempotency: disabled\n`);
  } else {
    const backend = storeSql !== null ? 'pg-backed' : 'memory-backed';
    const ttl =
      config.idempotency.defaultTtlMs === null
        ? 'default 24h'
        : `${config.idempotency.defaultTtlMs}ms`;
    process.stdout.write(`idempotency: enabled (${backend}, ttl=${ttl})\n`);
  }
  if (storeSql !== null) {
    process.stdout.write(
      `tombstone purge: enabled (retention=${config.tombstoneRetentionDays}d, cadence=${config.sweepIntervalMs}ms)\n`
    );
  }
  process.stdout.write(knobsBanner(config.knobs));
}
