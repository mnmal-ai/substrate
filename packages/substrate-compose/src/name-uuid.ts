import { createHash } from 'node:crypto';

/**
 * A deterministic row id for `name`: an RFC 9562 version-8 UUID whose custom
 * bits are the first 122 bits of sha256(name). The same name always yields the
 * same id, and the id passes the `rows_id_uuid_format` CHECK that
 * `SUBSTRATE_ENFORCE_UUID_CHECK` installs.
 */
export function uuidFromName(name: string): string {
  const b = createHash('sha256').update(name).digest().subarray(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
