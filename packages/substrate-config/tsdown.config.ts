import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { tsdown: 'src/tsdown.ts' },
  format: ['esm'],
  target: 'node26',
  clean: true,
  sourcemap: true,
  fixedExtension: false,
  dts: false,
  // The helpers return a plain config object the consumer passes to its own
  // tsdown; neither the JS nor the .d.ts imports tsdown.
  deps: { neverBundle: ['tsdown'] }
});
