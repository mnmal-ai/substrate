/**
 * The one module that imports msgpackr. The published bundle gives it a chunk
 * of its own, so a consumer that never packs or unpacks drops msgpackr, which
 * does not declare itself free of load-time side effects. These are wrappers,
 * not re-exports: a bundler resolves a re-export straight to msgpackr, which
 * would leave every importer of this module importing msgpackr itself.
 */
import * as msgpackr from 'msgpackr';

export const pack = (...args: Parameters<typeof msgpackr.pack>): ReturnType<typeof msgpackr.pack> =>
  msgpackr.pack(...args);

export const unpack = (
  ...args: Parameters<typeof msgpackr.unpack>
): ReturnType<typeof msgpackr.unpack> => msgpackr.unpack(...args);

export const createUnpackr = (options: msgpackr.Options): msgpackr.Unpackr =>
  new msgpackr.Unpackr(options);
