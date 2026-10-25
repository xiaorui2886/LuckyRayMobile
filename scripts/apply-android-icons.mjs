// Apply the reviewed, tracked LuckyRay Android icon set after every Tauri init.
// The build needs no network, private repository access or image-conversion tool.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
const sourcePaths = [
  'icon.png', 'luckyray-original.png', 'luckyray-android.png',
  ...densities.flatMap(d => ['ic_launcher.png', 'ic_launcher_round.png']
    .map(name => `android/mipmap-${d}/${name}`)),
  'android/mipmap-anydpi-v21/ic_launcher.xml',
  'android/drawable-nodpi/ic_launcher_artwork.png',
];
const obsoleteResources = [
  'mipmap-anydpi-v26/ic_launcher.xml', 'mipmap-anydpi-v26/ic_launcher_round.xml',
  'mipmap-anydpi-v33/ic_launcher.xml', 'mipmap-anydpi-v33/ic_launcher_round.xml',
  'values/ic_launcher_background.xml',
  ...densities.flatMap(d => ['foreground', 'background'].map(layer => `mipmap-${d}/ic_launcher_${layer}.png`)),
];

export function verifiedAndroidIcons(repoRoot) {
  const icons = join(repoRoot, 'src-tauri/icons');
  const manifest = JSON.parse(readFileSync(join(icons, 'luckyray-branding.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.files?.length !== sourcePaths.length
      || new Set(manifest.files.map(row => row.path)).size !== sourcePaths.length) {
    throw new Error('LuckyRay branding manifest is incomplete');
  }
  const geometry = manifest.androidGeometry;
  if (geometry?.revision !== 8 || geometry.kind !== 'complete-artwork-bitmap'
      || geometry.background !== 'source-transparency' || geometry.resourceMinApi !== 21
      || geometry.source !== 'luckyray-original.png' || geometry.derivedSource !== 'luckyray-android.png'
      || JSON.stringify(geometry.sourceCanvas) !== '[1254,1254]' || geometry.completePerimeter !== true
      || geometry.artworkResampled !== false || geometry.adaptiveWrapper !== false
      || JSON.stringify(geometry.contentBounds) !== '[177,128,1098,1054]'
      || JSON.stringify(geometry.artworkSize) !== '[926,926]' || JSON.stringify(geometry.transparentPad) !== '[2,0]'
      || JSON.stringify(geometry.perimeterControlPoints) !== '[[181,513],[185,513],[203,513],[650,138],[1067,600],[650,1047]]'
      || geometry.defringe?.method !== 'nearest-opaque-edge-rgb' || geometry.defringe.radiusPx !== 8
      || geometry.defringe.opaqueAlphaMin !== 250 || geometry.defringe.alphaUnchanged !== true
      || JSON.stringify(geometry.legacySizes) !== '{"mdpi":48,"hdpi":72,"xhdpi":96,"xxhdpi":144,"xxxhdpi":192}') {
    throw new Error('LuckyRay icon geometry is not reviewed');
  }
  const entries = new Map();
  for (const row of manifest.files) {
    if (!sourcePaths.includes(row.path) || !/^[0-9a-f]{64}$/.test(row.sha256)) {
      throw new Error('Unexpected LuckyRay branding resource');
    }
    const bytes = readFileSync(join(icons, row.path));
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) {
      throw new Error(`LuckyRay branding checksum mismatch: ${row.path}`);
    }
    entries.set(row.path, bytes);
  }
  const files = new Map([...entries].filter(([path]) => path.startsWith('android/'))
    .map(([path, bytes]) => [path.slice('android/'.length), bytes]));
  files.set('mipmap-anydpi-v21/ic_launcher_round.xml', files.get('mipmap-anydpi-v21/ic_launcher.xml'));
  return files;
}

function brandedManifest(xml) {
  const tags = [...xml.matchAll(/<application\b[^>]*>/g)];
  if (tags.length !== 1) throw new Error('Expected one generated Android application element');
  const packageName = xml.match(/<manifest\b[^>]*\bpackage\s*=\s*["']([^"']+)["']/)?.[1];
  if (packageName && packageName !== 'com.luckyray.mobile') throw new Error('Android package identity differs');
  const cleaned = tags[0][0].replace(/\s+android:(?:icon|roundIcon)\s*=\s*(?:"[^"]*"|'[^']*')/g, '');
  const branded = cleaned.replace(/^<application\b/, '<application android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round"');
  return xml.replace(tags[0][0], branded);
}

export function applyAndroidIcons(repoRoot, androidRoot = join(repoRoot, 'src-tauri/gen/android'), checkOnly = false) {
  // Verify every source before writing even one generated file.
  const files = verifiedAndroidIcons(repoRoot);
  const manifestPath = join(androidRoot, 'app/src/main/AndroidManifest.xml');
  if (!existsSync(manifestPath)) throw new Error('Run tauri android init before applying LuckyRay icons');
  const xml = readFileSync(manifestPath, 'utf8');
  const expected = brandedManifest(xml);
  const res = join(androidRoot, 'app/src/main/res');
  if (checkOnly) {
    if (xml !== expected) throw new Error('Generated Android manifest does not reference LuckyRay icons');
    for (const name of obsoleteResources) {
      if (existsSync(join(res, name))) throw new Error(`Obsolete adaptive icon remains: ${name}`);
    }
    for (const [name, bytes] of files) {
      const target = join(res, name);
      if (!existsSync(target) || !readFileSync(target).equals(bytes)) {
        throw new Error(`Generated LuckyRay icon missing or changed: ${name}`);
      }
    }
  } else {
    // Remove only retired overrides/layers. Every supported Android version
    // uses the complete artwork, instead of the old arrow-only adaptive image.
    for (const name of obsoleteResources) {
      const target = resolve(res, name);
      if (!target.startsWith(resolve(res) + sep)) {
        throw new Error('Refuse to remove an icon outside the generated resources');
      }
      rmSync(target, { force: true });
    }
    for (const [name, bytes] of files) {
      const target = join(res, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    writeFileSync(manifestPath, expected);
    applyAndroidIcons(repoRoot, androidRoot, true);
  }
  return { resourceFiles: files.size, manifest: 'PASS', checksums: 'PASS' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const args = process.argv.slice(2);
  if (args[0] === '--verify-source' && args.length === 1) {
    console.log(JSON.stringify({ source: 'PASS', resourceFiles: verifiedAndroidIcons(repoRoot).size }));
  } else {
    const checkOnly = args[0] === '--check';
    if (checkOnly) args.shift();
    if (args.length > 1 || args[0]?.startsWith('--')) throw new Error('Use [--check] [generated-android-directory], or --verify-source');
    console.log(JSON.stringify(applyAndroidIcons(repoRoot, args[0] ? resolve(args[0]) : undefined, checkOnly)));
  }
}
