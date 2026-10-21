// Ships the built-in plugins' default config and config schema beside the
// bundle, where package.json#substrate points the loader.
import { copyFileSync } from 'node:fs';

for (const name of ['recall', 'proposals']) {
  for (const file of ['default-config.json', 'config.schema.json']) {
    copyFileSync(
      new URL(`../../../plugins/substrate-${name}/${file}`, import.meta.url),
      new URL(`../dist/${name}.${file}`, import.meta.url)
    );
  }
}
