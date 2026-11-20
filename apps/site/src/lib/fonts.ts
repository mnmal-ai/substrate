import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const LICENSED_MONO = ['BerkeleyMono-Regular.woff2', 'BerkeleyMono-Bold.woff2'] as const;

/** True only when both licensed Berkeley Mono files sit under `<publicDir>/fonts/licensed/`. */
export function licensedMonoAvailable(publicDir: string): boolean {
  return LICENSED_MONO.every((f) => existsSync(join(publicDir, 'fonts', 'licensed', f)));
}
