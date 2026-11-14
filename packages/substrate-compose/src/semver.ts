/**
 * The one module that imports semver. The published bundle gives it a chunk of
 * its own, so a consumer that never checks a plugin's version range drops
 * semver, which does not declare itself free of load-time side effects.
 */
import semver from 'semver';

export function validRange(range: string): string | null {
  return semver.validRange(range);
}

export function satisfies(version: string, range: string): boolean {
  return semver.satisfies(version, range);
}
