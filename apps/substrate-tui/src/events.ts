// The import makes this file a module that depends on surface-core, which TypeScript
// needs before it will resolve the augmentation target below.
import type {} from '@mnmal-ai/surface-core';

declare module '@mnmal-ai/surface-core' {
  interface TuiEvents {
    /** The active namespace changed (from /ns); status follows it. */
    'substrate/ns': { namespace: string };
  }
}
