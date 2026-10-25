import { build } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// Synchronous output writes also work in constrained Windows application sandboxes.
const result = await build({ build: { write: false } });
for (const bundle of Array.isArray(result) ? result : [result]) {
  if (!('output' in bundle)) continue;
  for (const item of bundle.output) {
    const path = resolve('dist', item.fileName);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, item.type === 'chunk' ? item.code : item.source);
  }
}
console.log('Dashboard written to dist/.');

