import type { Sql } from 'postgres';

/** PostgreSQL 18.0, as `server_version_num` spells it. */
export const MIN_SERVER_VERSION_NUM = 180000;

/** The connected server is older than {@link MIN_SERVER_VERSION_NUM}. */
export class UnsupportedServerVersionError extends Error {
  constructor(readonly found: number) {
    super(
      `substrate requires PostgreSQL 18 or newer; the server reports server_version_num ${found}`
    );
    this.name = 'UnsupportedServerVersionError';
  }
}

/** Throws {@link UnsupportedServerVersionError} when `num` is below the minimum. */
export function checkServerVersionNum(num: number): void {
  if (num < MIN_SERVER_VERSION_NUM) throw new UnsupportedServerVersionError(num);
}

/** Refuses a server older than PostgreSQL 18. */
export async function assertServerVersion(sql: Sql): Promise<void> {
  const [row] = await sql<Array<{ num: number }>>`
    SELECT current_setting('server_version_num')::int AS num
  `;
  checkServerVersionNum(row?.num ?? 0);
}
