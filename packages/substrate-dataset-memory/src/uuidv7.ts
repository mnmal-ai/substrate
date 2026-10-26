import { randomBytes } from 'node:crypto';

let lastMs = -1;
let counter = 0;

/**
 * An RFC 9562 version-7 UUID: 48-bit unix milliseconds, then a 12-bit counter
 * in `rand_a`, then 62 random bits. Ids from one process sort in creation
 * order: the counter steps within a millisecond, and on overflow or a clock
 * step backwards the timestamp advances past the last one issued.
 *
 * Limits: the order holds only within this process, so it is never a
 * happened-before signal across writers; the id reveals its creation time; and
 * deciding who won uses a transaction time or a per-row version, never the id.
 */
export function uuidv7(): string {
  const now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    // Random start in the lower half leaves room to count within the millisecond.
    counter = randomBytes(2).readUInt16BE(0) & 0x7ff;
  } else if (++counter > 0xfff) {
    lastMs++;
    counter = 0;
  }
  const b = randomBytes(16);
  b.writeUIntBE(lastMs, 0, 6);
  b[6] = 0x70 | (counter >> 8);
  b[7] = counter & 0xff;
  b[8] = (b.readUInt8(8) & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
