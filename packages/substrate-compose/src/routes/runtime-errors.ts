import type { RuntimeStats } from '@mnmal-ai/substrate-core';
import { grantedIn, grantOf, type HttpHandler } from '@mnmal-ai/substrate-types';
import { jsonResponse } from './helpers.js';

/**
 * `authOff` is the trusted-local deployment: the system actor sees every entry.
 * Otherwise an entry is visible only to a caller holding the admin capability
 * (`adminCapability`, default `admin`) in the entry's namespace; unqualified
 * or unknown keys (`(unknown)`) need it on `*`.
 */
export function errorsRouteHandler(
  stats: RuntimeStats,
  opts: { authOff?: boolean; adminCapability?: string } = {}
): HttpHandler {
  const admin = opts.adminCapability ?? 'admin';
  return (req) => {
    const snap = stats.errors();
    if (opts.authOff === true) return jsonResponse(200, snap);
    const grant = grantOf(req.identity ?? null);
    const visible = (key: string): boolean => {
      const slash = key.indexOf('/');
      if (slash <= 0 || key.startsWith('(unknown)')) {
        return grant?.['*']?.includes(admin) === true;
      }
      return grantedIn(grant, key.slice(0, slash)).includes(admin);
    };
    return jsonResponse(200, { ...snap, errors: snap.errors.filter((e) => visible(e.key)) });
  };
}
