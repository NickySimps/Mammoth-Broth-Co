import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(new URL('../firebase.json', import.meta.url), 'utf8'));
for (const pattern of ['firebase/**', 'server/**', 'tests/**', 'scripts/**', '**/*.log', 'package*.json', '*.rules']) {
  assert.ok(config.hosting.ignore.includes(pattern), `Hosting must exclude private/backend source: ${pattern}`);
}
console.log('hosting publication boundary tests passed');
