import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packagePath = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
const entries = [pkg.main, pkg.types, ...Object.values(pkg.exports ?? {})]
  .filter((entry) => typeof entry === 'string' && entry !== './package.json')
  .map((entry) => entry.replace(/^\.\//, ''));

for (const entry of new Set(entries)) {
  const path = new URL(`../${entry}`, import.meta.url);
  await access(path);
  const result = spawnSync(process.execPath, ['--check', fileURLToPath(path)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Verified ${entries.length} published runtime artifact(s).`);
