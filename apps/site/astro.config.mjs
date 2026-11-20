import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://mnmal-ai.github.io',
  base: '/substrate',
  output: 'static',
  // Astro 7's default ('jsx') drops the whitespace between inline elements, which runs nav
  // links and feed fields together; true keeps Astro 6's collapse-to-one-space output.
  compressHTML: true
});
