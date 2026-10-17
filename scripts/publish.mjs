// Mirrors each channel's latest IMAI desktop release from downloads.imai.studio
// as a GitHub release (see .github/workflows/publish.yml). Node built-ins and
// the gh CLI only.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'https://downloads.imai.studio';
const CHANNELS = ['stable', 'beta', 'preview'];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const git = (args) => execFileSync('git', args, { stdio: 'inherit' });

function releaseExists(tag) {
  try {
    gh(['release', 'view', tag, '--json', 'tagName']);
    return true;
  } catch {
    return false;
  }
}

function checkManifest(manifest, channel) {
  const prefix = `${ORIGIN}/desktop/${channel}/`;
  if (manifest?.schemaVersion !== 1 || manifest.channel !== channel) throw new Error(`${channel}: unexpected manifest`);
  if (!VERSION.test(manifest.version) || (channel === 'stable') === manifest.version.includes('-'))
    throw new Error(`${channel}: bad version ${manifest.version}`);
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) throw new Error(`${channel}: no assets`);
  for (const asset of manifest.assets) {
    if (!/^[\w.-]+$/.test(asset.name) || !String(asset.url).startsWith(prefix) || !String(asset.url).endsWith(`/${asset.name}`))
      throw new Error(`${channel}: bad asset ${asset.name}`);
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0)
      throw new Error(`${channel}: bad digest for ${asset.name}`);
  }
}

async function download(asset, dir) {
  const response = await fetch(asset.url, { redirect: 'error' });
  if (!response.ok) throw new Error(`${asset.url} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
    throw new Error(`${asset.name} does not match the manifest`);
  const path = join(dir, asset.name);
  writeFileSync(path, bytes);
  return path;
}

let published = 0;
for (const channel of CHANNELS) {
  const response = await fetch(`${ORIGIN}/desktop/${channel}/release.json`, { redirect: 'error', cache: 'no-store' });
  if (response.status === 404) continue;
  if (!response.ok) throw new Error(`${channel}: release.json returned HTTP ${response.status}`);
  const text = await response.text();
  const manifest = JSON.parse(text);
  checkManifest(manifest, channel);
  const tag = `v${manifest.version}`;
  if (releaseExists(tag)) {
    console.log(`${channel}: ${tag} is already published`);
    continue;
  }
  const dir = mkdtempSync(join(tmpdir(), 'imai-desktop-'));
  const files = [];
  for (const asset of manifest.assets) files.push(await download(asset, dir));
  const dmg = (arch) => manifest.assets.find((asset) => asset.kind === 'dmg' && asset.arch === arch)?.name;
  const notes = [
    `IMAI desktop ${manifest.version} for macOS.`,
    '',
    `- Apple silicon: ${dmg('arm64') ?? 'not in this release'}`,
    `- Intel: ${dmg('x64') ?? 'not in this release'}`,
    '',
    'Open the disk image and drag IMAI to Applications. Signed with a Developer ID certificate and notarized by Apple; the app updates itself in place once installed.',
  ].join('\n');
  // Recording the manifest keeps this repository active, so GitHub keeps the schedule running.
  writeFileSync(`releases/${channel}.json`, text.endsWith('\n') ? text : `${text}\n`);
  git(['add', `releases/${channel}.json`]);
  git(['-c', 'user.name=imai-desktop-releases', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com', 'commit', '-q', '-m', `Release ${tag}`]);
  git(['push', '-q', 'origin', 'HEAD:main']);
  gh(['release', 'create', tag, ...files, '--title', `IMAI ${manifest.version}`, '--notes', notes, '--target', 'main',
    ...(channel === 'stable' ? ['--latest'] : ['--prerelease', '--latest=false'])]);
  console.log(`${channel}: published ${tag}`);
  published += 1;
}
console.log(published ? `Published ${published} release(s).` : 'Nothing new to publish.');
