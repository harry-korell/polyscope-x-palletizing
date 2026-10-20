import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectThirdPartyNotices } from '../scripts/collect-third-party-notices.mjs';

const root = resolve(import.meta.dirname, '..');
const destination = resolve(root, 'dist/palletizing-web');
await rm(resolve(root, 'dist'), { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: { main: 'web/src/main.ts', pallet: 'web/src/pallet.worker.ts', phase: 'web/src/phase.worker.ts' },
  outdir: destination, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120',
  sourcemap: false, minify: true, legalComments: 'external', metafile: true,
  entryNames: '[name]',
});
await cp(resolve(root, 'web/contribution.json'), resolve(destination, 'contribution.json'));
await cp(resolve(root, 'web/assets'), resolve(destination, 'assets'), { recursive: true });
await cp(resolve(root, 'manifest.yaml'), resolve(root, 'dist/manifest.yaml'));
await cp(resolve(root, 'LICENSE'), resolve(root, 'dist/LICENSE'));
await collectThirdPartyNotices({ root, outputDirectory: resolve(root, 'dist'), metafile: result.metafile });
const packages = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(root, 'package.json'), 'utf8'));
await writeFile(resolve(root, 'dist/dependencies.json'), JSON.stringify(packages.dependencies, null, 2));
console.log('Web contribution built: dist/palletizing-web');
