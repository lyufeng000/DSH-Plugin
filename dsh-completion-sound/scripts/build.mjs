import { readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const core = (await readFile(new URL('lib/lifecycle.js', root), 'utf8')).replaceAll('export function ', 'function ');
const monitor = (await readFile(new URL('lib/monitor.js', root), 'utf8')).replace(/^import .*;\r?\n/m, '').replaceAll('export function ', 'function ');
const input = await readFile(new URL('src/client.js', root), 'utf8');
if (!input.includes('/* LIFECYCLE_CORE */')) throw new Error('Lifecycle insertion marker missing');
const output = input.replace('/* LIFECYCLE_CORE */', () => core + '\n' + monitor);
if (process.argv.includes('--check')) {
  if (await readFile(new URL('client.js', root), 'utf8') !== output) throw new Error('Client build is stale');
  console.log('PASS: client build matches source');
} else {
  await writeFile(new URL('client.js', root), output);
  console.log('Built client.js');
}
