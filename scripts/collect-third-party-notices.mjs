import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// These unmodified SDK terms match LICENSE.pdf in the three pinned SDK packages.
const sdkTermsPath = 'licenses/Universal-Robots-SDK-Terms.md';
const sdkTermsSha256 = '95c864dcecd5faea0432baffd89879acf824338e8ee134825d8c3afb7391d0a0';
const sdkPdfSha256 = '83c6eb847778a826fdc106a87c4c20772f3be9ccc7744e4d656fbb7bbb1c3e67';
const sdkTermsSource = 'https://raw.githubusercontent.com/UniversalRobots/PolyScopeX_URCap_SDK/afb9f33d0726c70c9ad84096dbc51989c3ee9137/LICENSE.md';
const iscSource = 'https://raw.githubusercontent.com/spdx/license-list-data/main/text/ISC.txt';

// These exact published packages declare ISC but ship no LICENSE/NOTICE file.
// The standard template is explanatory, not an invented upstream copyright notice.
const iscWithoutLicenseFile = new Map([
  ['guid-typescript@1.0.9', 'https://github.com/snico-dev/guid-typescript'],
  ['@universal-robots/ros2-foxglove-interfaces@4.1.7', 'https://pkgs.dev.azure.com/polyscopex/api/_packaging/polyscopex/npm/registry/@universal-robots%2fros2-foxglove-interfaces'],
]);
const iscTemplate = `ISC License

Copyright <year> <owner>

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
`;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const slash = (path) => path.split(sep).join('/');
const licenseName = /^(?:licen[cs]e|copying|copyright(?:notice)?|notice)(?:[._-].*)?$/i;

function codeBlock(text) {
  const fences = text.match(/`+/g) ?? [];
  const fence = '`'.repeat(Math.max(3, ...fences.map((value) => value.length + 1)));
  return `${fence}text\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n`;
}

function packageDirectory(root, input) {
  const path = slash(relative(root, resolve(root, input)));
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  if (index < 0) return undefined;
  const tail = path.slice(index + marker.length).split('/');
  const count = tail[0].startsWith('@') ? 2 : 1;
  if (tail.length <= count) throw new Error(`Cannot identify package for bundled input: ${input}`);
  const directory = resolve(root, path.slice(0, index + marker.length) + tail.slice(0, count).join('/'));
  const withinRoot = relative(root, directory);
  if (withinRoot.startsWith(`..${sep}`) || isAbsolute(withinRoot)) {
    throw new Error(`Bundled package escapes project directory: ${input}`);
  }
  return directory;
}

/** Collect notices from packages that contribute bytes to actual esbuild outputs. No network access. */
export async function collectThirdPartyNotices({ root, outputDirectory, metafile }) {
  if (!metafile?.outputs) throw new Error('esbuild metafile is required for third-party notices');
  const terms = await readFile(resolve(root, sdkTermsPath));
  if (sha256(terms) !== sdkTermsSha256) throw new Error('The reviewed Universal Robots SDK terms were modified');

  const packages = new Map();
  for (const [output, details] of Object.entries(metafile.outputs)) {
    for (const [input, contribution] of Object.entries(details.inputs ?? {})) {
      if (contribution.bytesInOutput <= 0) continue;
      const directory = packageDirectory(root, input);
      if (!directory) continue;
      const entry = packages.get(directory) ?? { directory, bytesInOutput: 0, outputs: new Set() };
      entry.bytesInOutput += contribution.bytesInOutput;
      entry.outputs.add(output);
      packages.set(directory, entry);
    }
  }
  if (!packages.size) throw new Error('No bundled packages found; refusing to create empty notices');

  const runtimePackages = [];
  for (const entry of packages.values()) {
    const metadataBytes = await readFile(resolve(entry.directory, 'package.json'));
    const metadata = JSON.parse(metadataBytes.toString('utf8'));
    if (!metadata.name || !metadata.version || !metadata.license) {
      throw new Error(`Incomplete license metadata: ${entry.directory}`);
    }
    const identifier = `${metadata.name}@${metadata.version}`;
    const folder = identifier.replace(/^@/, '').replaceAll('/', '__');
    const destination = resolve(outputDirectory, 'licenses', folder);
    await mkdir(destination, { recursive: true });
    // Preserve the publisher's original identity and license declaration as well.
    await cp(resolve(entry.directory, 'package.json'), resolve(destination, 'package.json'));
    const files = (await readdir(entry.directory, { withFileTypes: true }))
      .filter((file) => file.isFile() && licenseName.test(file.name))
      .map((file) => file.name).sort();
    const notices = [];
    for (const name of files) {
      const bytes = await readFile(resolve(entry.directory, name));
      await cp(resolve(entry.directory, name), resolve(destination, name));
      const path = `licenses/${folder}/${name}`;
      if (/\.pdf$/i.test(name)) {
        if (!metadata.name.startsWith('@universal-robots/') || sha256(bytes) !== sdkPdfSha256) {
          throw new Error(`Unreviewed PDF license requires a readable companion text: ${identifier}/${name}`);
        }
        notices.push({ path, sha256: sha256(bytes), readableCompanion: sdkTermsPath });
      } else {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        notices.push({ path, sha256: sha256(bytes), text });
      }
    }
    const iscFallback = !notices.length && metadata.license === 'ISC' && iscWithoutLicenseFile.get(identifier);
    if (!notices.length && !iscFallback) throw new Error(`No license/notice file for bundled package ${identifier}`);
    runtimePackages.push({
      name: metadata.name, version: metadata.version, license: metadata.license,
      author: metadata.author, upstream: iscFallback || metadata.repository?.url || metadata.homepage,
      packageMetadata: `licenses/${folder}/package.json`, packageMetadataSha256: sha256(metadataBytes),
      bytesInOutput: entry.bytesInOutput, outputs: [...entry.outputs].sort(), notices,
      ...(iscFallback ? { standardLicenseTemplate: 'ISC', standardLicenseTemplateSource: iscSource } : {}),
    });
  }
  runtimePackages.sort((left, right) => left.name.localeCompare(right.name, 'en'));

  await mkdir(resolve(outputDirectory, 'licenses'), { recursive: true });
  await cp(resolve(root, sdkTermsPath), resolve(outputDirectory, sdkTermsPath));
  const lines = [
    '# Third-party notices', '',
    'Generated by `web/build.mjs` from the packages that contribute bytes to the actual esbuild browser and worker outputs. Development-only and completely tree-shaken packages are excluded. Package versions are pinned in `package-lock.json`.', '',
    'Original project code retains its separate `LICENSE`. This document does not relicense third-party code or add permissions. Original license/notice attachments and publisher package metadata are copied byte-for-byte into the `licenses/` directory of the downloadable URCap package.', '',
    '## Bundled packages', '',
    '| Package | Version | Publisher license declaration |', '| --- | --- | --- |',
    ...runtimePackages.map((entry) => `| ${entry.name} | ${entry.version} | ${entry.license} |`), '',
    '## Universal Robots SDK terms', '',
    `Readable, unmodified source: ${sdkTermsSource}`, '',
    `Included attachment: \`${sdkTermsPath}\` (SHA-256 \`${sdkTermsSha256}\`). The original, identical LICENSE.pdf files are also retained with each bundled SDK package. The SDK terms govern those SDK components; no SDK rights are granted by the project LICENSE.`, '',
    codeBlock(terms.toString('utf8')),
  ];
  for (const entry of runtimePackages) {
    lines.push(`## ${entry.name} ${entry.version}`, '', `Publisher license declaration: \`${entry.license}\`.`, '',
      `Original package metadata in the URCap package: \`${entry.packageMetadata}\` (SHA-256 \`${entry.packageMetadataSha256}\`).`, '');
    if (entry.author) lines.push(`Author as declared by the publisher: ${typeof entry.author === 'string' ? entry.author : JSON.stringify(entry.author)}.`, '');
    if (entry.upstream) lines.push(`Publisher/upstream reference: ${entry.upstream}`, '');
    for (const notice of entry.notices) {
      lines.push(`### ${notice.path}`, '', `Original attachment SHA-256: \`${notice.sha256}\`.`, '');
      lines.push(notice.text === undefined
        ? `The original PDF is included unchanged in the package. Its complete readable terms are reproduced above and included as \`${notice.readableCompanion}\`.\n`
        : codeBlock(notice.text));
    }
    if (entry.standardLicenseTemplate) {
      lines.push(
        '### ISC declaration without a shipped license file', '',
        'This exact package declares ISC in its original package.json but publishes no separate LICENSE, NOTICE or copyright file. No verified version-specific original license text was available. The following is the standard ISC template identified by that declaration, reproduced with its placeholders unchanged. It is not presented as a publisher-supplied notice, and no copyright holder or date has been invented.', '',
        `Standard template source: ${iscSource}`, '', codeBlock(iscTemplate),
      );
    }
  }
  const document = `${lines.join('\n')}\n`;
  await writeFile(resolve(root, 'THIRD_PARTY_NOTICES.md'), document);
  await writeFile(resolve(outputDirectory, 'THIRD_PARTY_NOTICES.md'), document);
  // The machine-readable inventory deliberately omits duplicate full license bodies.
  await writeFile(resolve(outputDirectory, 'third-party-manifest.json'), `${JSON.stringify({
    sdkTerms: { path: sdkTermsPath, sha256: sdkTermsSha256, source: sdkTermsSource },
    runtimePackages: runtimePackages.map((entry) => ({ ...entry, notices: entry.notices.map(({ text, ...notice }) => notice) })),
  }, null, 2)}\n`);
  console.log(`Third-party notices collected for ${runtimePackages.length} bundled packages`);
}
