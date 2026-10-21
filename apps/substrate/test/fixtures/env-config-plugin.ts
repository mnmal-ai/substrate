/**
 * Fixture plugin for env-config.test.ts dynamic-import checks. Kept minimal —
 * it contributes one namespace whose install is a no-op. The loader only
 * cares that `default` resolves to a valid `CoordinatorPlugin`; every
 * install-time side effect is exercised by the plugin-seam tests already.
 */

import type { CoordinatorPlugin } from '@mnmal-ai/substrate-types';

const plugin: CoordinatorPlugin = {
  name: 'env-fixture',
  contractVersion: '*',
  namespaces: [
    {
      namespace: 'env-fixture',
      install: (): void => undefined
    }
  ]
};

export default plugin;
