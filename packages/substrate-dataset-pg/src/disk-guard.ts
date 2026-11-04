import { statfs as fsStatfs } from 'node:fs/promises';

/**
 * Refuses a background index build that would leave less than a margin of
 * free space on the database volume. Postgres cannot report filesystem space,
 * so the volume is a local path the operator names; with none, every build is
 * allowed and `path` is undefined so the storage report can say checks are off.
 */
export interface DiskGuard {
  readonly path: string | undefined;
  check(
    estimateBytes: number
  ): Promise<{ ok: true } | { ok: false; freeBytes: number; needBytes: number }>;
}

export function makeDiskGuard(opts: {
  path?: string;
  marginBytes: number;
  statfs?: (p: string) => Promise<{ bavail: bigint; bsize: bigint }>;
}): DiskGuard {
  const { path, marginBytes } = opts;
  const statfs = opts.statfs ?? ((p: string) => fsStatfs(p, { bigint: true }));
  return {
    path,
    async check(estimateBytes) {
      if (path === undefined) return { ok: true };
      const s = await statfs(path);
      const freeBytes = Number(s.bavail * s.bsize);
      const needBytes = estimateBytes + marginBytes;
      return freeBytes >= needBytes ? { ok: true } : { ok: false, freeBytes, needBytes };
    }
  };
}
