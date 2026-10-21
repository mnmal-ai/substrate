/**
 * `_system` admin + registration routes. Spec §5.12.
 *
 * Barrel only — each route lives in its own module under `./routes/`:
 *
 *   POST /substrate/v1/_system/invites   — `./routes/invites.js` (admin-gated)
 *   POST /substrate/v1/_system/keys      — `./routes/keys.js` (admin-gated)
 *   PATCH /substrate/v1/_system/keys     — `./routes/key-patch.js`
 *   GET /substrate/v1/_system/keys       — `./routes/keys-list.js`
 *   POST /substrate/v1/_system/register  — `./routes/register.js` (public)
 *
 * Shared validators + the `_system` wire shape live in `./routes/shared.js`.
 *
 * All routes return JSON only. substrate-pack negotiation is skipped for admin /
 * bootstrap surfaces — the code is a bearer-like secret, tooling that consumes
 * it shouldn't need to wire up a positional decoder.
 */

export { invitesRoute } from './routes/invites.js';
export { keyPatchRoute } from './routes/key-patch.js';
export { keysRoute } from './routes/keys.js';
export { keysListRoute } from './routes/keys-list.js';
export { registerRoute } from './routes/register.js';
export {
  extractClientIp,
  type KeysRouteOptions,
  type RegisterAlgorithm
} from './routes/shared.js';
