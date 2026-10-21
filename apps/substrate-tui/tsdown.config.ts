import { defineBinTsdown } from '@mnmal-ai/substrate-config/tsdown';

export default defineBinTsdown({
  entry: { 'bin/substrate-tui': 'src/bin/tui.tsx' },
  banner: { js: '#!/usr/bin/env node' },
  // Ink, React and our own packages resolve from node_modules at runtime: one React, one Ink.
  neverBundle: [/^@mnmal-ai\//, 'ink', 'react', /^react\//, 'string-width']
});
