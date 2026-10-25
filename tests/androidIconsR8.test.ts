import test from 'node:test';
import { inflateSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifiedAndroidIcons, applyAndroidIcons } from '../scripts/apply-android-icons.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const icons = join(repo, 'src-tauri/icons');
const hash = b => createHash('sha256').update(b).digest('hex');
const manifest = JSON.parse(readFileSync(join(icons, 'luckyray-branding.json'), 'utf8'));
const xml = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.luckyray.mobile">
  <uses-permission android:name="android.permission.INTERNET"/>
  <application android:label="LuckyRay Mobile" android:icon="@mipmap/tauri" android:roundIcon="@mipmap/default_round" android:allowBackup="false">
    <activity android:name=".MainActivity" android:exported="true"/>
  </application>
</manifest>`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'luckyray-icons-test-'));
  for (const name of ['luckyray-branding.json', ...manifest.files.map(r => r.path)]) {
    const target = join(root, 'src-tauri/icons', name);
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(icons, name), target);
  }
  const android = join(root, 'generated Android 手机');
  const path = join(android, 'app/src/main/AndroidManifest.xml');
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, xml);
  return { root, android, path, res: join(android, 'app/src/main/res') };
}
function cleanup(root) {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('luckyray-icons-test-'));
  rmSync(root, { recursive: true, force: true });
}
function outputHashes(f) {
  return [...verifiedAndroidIcons(f.root)].map(([name]) => [name, hash(readFileSync(join(f.res, name)))]);
}

test('official purple-arrow artwork has the fixed reviewed hash and all density resources', () => {
  assert.equal(manifest.sourceRevision, '8479bbf20cf01d608b2415e746d74fe12b4081e7');
  const png = readFileSync(join(icons, 'icon.png'));
  assert.equal(hash(png), 'fed987e1689e8bdb15eaad881e18e0f5d38bda3bc83fc17c2a10a4b977fd0a0c');
  assert.equal(png.readUInt32BE(16), 512); assert.equal(png.readUInt32BE(20), 512);
  assert.equal(manifest.files.length, 15);
  assert.equal(verifiedAndroidIcons(repo).size, 13);
  assert.deepEqual(manifest.androidGeometry, {
    revision: 8, kind: 'complete-artwork-bitmap', background: 'source-transparency',
    source: 'luckyray-original.png', derivedSource: 'luckyray-android.png', sourceCanvas: [1254,1254],
    legacySizes: { mdpi:48,hdpi:72,xhdpi:96,xxhdpi:144,xxxhdpi:192 },
    resourceMinApi:21, contentBounds:[177,128,1098,1054], artworkSize:[926,926], transparentPad:[2,0],
    artworkResampled:false, completePerimeter:true, adaptiveWrapper:false,
    perimeterControlPoints:[[181,513],[185,513],[203,513],[650,138],[1067,600],[650,1047]],
    defringe:{method:'nearest-opaque-edge-rgb',radiusPx:8,opaqueAlphaMin:250,alphaUnchanged:true},
  });
  for (const [density, size] of Object.entries(manifest.androidGeometry.legacySizes)) {
    const normal = readFileSync(join(icons, `android/mipmap-${density}/ic_launcher.png`));
    const round = readFileSync(join(icons, `android/mipmap-${density}/ic_launcher_round.png`));
    assert.equal(normal.readUInt32BE(16), size);
    assert.equal(normal.readUInt32BE(20), size);
    assert.ok(normal.equals(round), 'round variant must preserve the complete Desktop artwork');
  }
  assert.equal(existsSync(join(icons, 'android/mipmap-anydpi-v26/ic_launcher.xml')), false);
});

test('the full-resolution original is pinned and cover cropping is rejected before generated writes', () => {
  const original = readFileSync(join(icons, 'luckyray-original.png'));
  assert.equal(hash(original), '74924112feeb2451c738b8a21fb252d501c0e4b94ab4d75b16846cb0f5e666ae');
  assert.equal(original.readUInt32BE(16), 1254); assert.equal(original.readUInt32BE(20), 1254);
  const f = fixture();
  try {
    const altered = structuredClone(manifest); altered.androidGeometry.contentBounds = [200,150,1060,1040];
    writeFileSync(join(f.root, 'src-tauri/icons/luckyray-branding.json'), JSON.stringify(altered));
    assert.throws(() => applyAndroidIcons(f.root, f.android), /icon geometry/);
    assert.equal(readFileSync(f.path, 'utf8'), xml); assert.equal(existsSync(f.res), false);
  } finally { cleanup(f.root); }
});

test('obsolete adaptive geometry is rejected before writing', () => {
  const f = fixture();
  try {
    const altered = structuredClone(manifest);
    altered.androidGeometry.adaptiveWrapper = true;
    writeFileSync(join(f.root, 'src-tauri/icons/luckyray-branding.json'), JSON.stringify(altered));
    assert.throws(() => applyAndroidIcons(f.root, f.android), /icon geometry/);
    assert.equal(readFileSync(f.path, 'utf8'), xml); assert.equal(existsSync(f.res), false);
  } finally { cleanup(f.root); }
});

test('actual icon patch writes normal and round bitmaps and preserves application identity', () => {
  const f = fixture();
  try {
    assert.equal(applyAndroidIcons(f.root, f.android).resourceFiles, 13);
    assert.deepEqual(applyAndroidIcons(f.root, f.android, true), { resourceFiles: 13, manifest: 'PASS', checksums: 'PASS' });
    const applied = readFileSync(f.path, 'utf8');
    for (const value of ['package="com.luckyray.mobile"', 'android:label="LuckyRay Mobile"', 'android:allowBackup="false"', 'android.permission.INTERNET', 'android:name=".MainActivity"']) assert.ok(applied.includes(value));
    assert.ok(applied.includes('android:icon="@mipmap/ic_launcher"'));
    assert.ok(applied.includes('android:roundIcon="@mipmap/ic_launcher_round"'));
    const bitmap = readFileSync(join(f.res,'mipmap-anydpi-v21/ic_launcher.xml'),'utf8');
    assert.ok(bitmap.includes('<bitmap')); assert.ok(bitmap.includes('@drawable/ic_launcher_artwork'));
    assert.ok(bitmap.includes('android:filter="true"')); assert.ok(!bitmap.includes('adaptive-icon'));
    assert.equal(readFileSync(join(f.res,'mipmap-anydpi-v21/ic_launcher_round.xml'),'utf8'),bitmap);
    for(const version of [26,33]) for(const name of ['ic_launcher','ic_launcher_round']) {
      assert.equal(existsSync(join(f.res,`mipmap-anydpi-v${version}/${name}.xml`)),false);
    }
  } finally { cleanup(f.root); }
});

test('repeated application and a fresh Tauri manifest reproduce identical icon bytes', () => {
  const f = fixture();
  try {
    applyAndroidIcons(f.root, f.android);
    const first = outputHashes(f); const firstXml = readFileSync(f.path, 'utf8');
    applyAndroidIcons(f.root, f.android);
    assert.deepEqual(outputHashes(f), first); assert.equal(readFileSync(f.path, 'utf8'), firstXml);
    writeFileSync(f.path, xml); writeFileSync(join(f.res, 'mipmap-mdpi/ic_launcher.png'), 'template icon');
    applyAndroidIcons(f.root, f.android);
    assert.deepEqual(outputHashes(f), first); assert.equal(readFileSync(f.path, 'utf8'), firstXml);
  } finally { cleanup(f.root); }
});

test('read-only validation rejects missing or corrupt generated resources without repairing them', () => {
  const f = fixture();
  try {
    applyAndroidIcons(f.root, f.android);
    const missing = join(f.res, 'mipmap-mdpi/ic_launcher.png'); rmSync(missing);
    assert.throws(() => applyAndroidIcons(f.root, f.android, true), /missing or changed/); assert.equal(existsSync(missing), false);
    writeFileSync(missing, 'corrupt');
    assert.throws(() => applyAndroidIcons(f.root, f.android, true), /missing or changed/); assert.equal(readFileSync(missing, 'utf8'), 'corrupt');
  } finally { cleanup(f.root); }
});

test('changed controlled artwork is rejected before any generated write', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'src-tauri/icons/android/mipmap-mdpi/ic_launcher.png'), 'unreviewed artwork');
    assert.throws(() => applyAndroidIcons(f.root, f.android), /checksum mismatch/);
    assert.equal(readFileSync(f.path, 'utf8'), xml); assert.equal(existsSync(f.res), false);
  } finally { cleanup(f.root); }
});

test('unknown source paths and duplicate resource entries fail closed', () => {
  for (const kind of ['unknown', 'duplicate']) {
    const f = fixture();
    try {
      const altered = structuredClone(manifest);
      if (kind === 'unknown') altered.files[0].path = '../outside.png'; else altered.files[1] = altered.files[0];
      writeFileSync(join(f.root, 'src-tauri/icons/luckyray-branding.json'), JSON.stringify(altered));
      assert.throws(() => applyAndroidIcons(f.root, f.android), /manifest is incomplete|Unexpected/);
      assert.equal(readFileSync(f.path, 'utf8'), xml); assert.equal(existsSync(f.res), false);
    } finally { cleanup(f.root); }
  }
});

test('missing generated project, wrong package and ambiguous manifests are rejected', () => {
  const f = fixture();
  try {
    assert.throws(() => applyAndroidIcons(f.root, join(f.android, 'missing')), /android init/);
    for (const value of [xml.replace('com.luckyray.mobile', 'other.app'), xml.replace('</manifest>', '<application/></manifest>')]) {
      writeFileSync(f.path, value);
      assert.throws(() => applyAndroidIcons(f.root, f.android), /identity differs|one generated/);
      assert.equal(readFileSync(f.path, 'utf8'), value);
    }
  } finally { cleanup(f.root); }
});

test('CLI works outside the repository with spaces and Chinese in the generated path', () => {
  const f = fixture();
  try {
    const script = join(repo, 'scripts/apply-android-icons.mjs');
    for (const args of [[f.android], ['--check', f.android]]) {
      const result = spawnSync(process.execPath, [script, ...args], { cwd: tmpdir(), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).resourceFiles, 13);
    }
  } finally { cleanup(f.root); }
});

// Decode RGBA PNG pixels without requiring an image editor in CI.
function rgbaPng(bytes) {
  assert.equal(bytes[25], 6, 'icons must retain an RGBA channel');
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  const chunks = [];
  for (let at = 8; at < bytes.length;) {
    const size = bytes.readUInt32BE(at); const type = bytes.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') chunks.push(bytes.subarray(at + 8, at + 8 + size));
    at += size + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)); const stride = width * 4;
  assert.equal(raw.length, height * (stride + 1));
  const pixels = Buffer.alloc(width * height * 4);
  const paeth = (a,b,c) => { const p = a+b-c; const x = Math.abs(p-a); const y = Math.abs(p-b); const z = Math.abs(p-c); return x <= y && x <= z ? a : y <= z ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter >= 0 && filter <= 4);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x; const left = x >= 4 ? pixels[at - 4] : 0;
      const up = y ? pixels[at - stride] : 0; const corner = y && x >= 4 ? pixels[at - stride - 4] : 0;
      const prediction = [0, left, up, Math.floor((left+up)/2), paeth(left,up,corner)][filter];
      pixels[at] = (raw[y * (stride + 1) + 1 + x] + prediction) & 255;
    }
  }
  return { width, height, pixels };
}

test('defringing preserves every original alpha byte and all nearly opaque artwork', () => {
  const original = rgbaPng(readFileSync(join(icons, 'luckyray-original.png')));
  const derived = rgbaPng(readFileSync(join(icons, 'luckyray-android.png')));
  assert.equal(derived.width, original.width); assert.equal(derived.height, original.height);
  let changed = 0;
  for (let at = 0; at < original.pixels.length; at += 4) {
    assert.equal(derived.pixels[at+3], original.pixels[at+3], 'no alpha erosion, matte, crop or extra margin');
    const same = derived.pixels.subarray(at,at+3).equals(original.pixels.subarray(at,at+3));
    if (original.pixels[at+3] >= 250 || original.pixels[at+3] === 0) assert.ok(same, 'authored opaque artwork and invisible exterior RGB must stay intact');
    if (!same) changed++;
  }
  assert.ok(changed > 0 && changed < original.width * original.height * 0.05, 'only a small semi-transparent fringe is touched');
  const at = (450 * original.width + 179) * 4;
  assert.equal(original.pixels[at+3], 25);
  assert.ok(Math.max(...original.pixels.subarray(at,at+3)) >= 250, 'fixture retains the known white-matted edge');
  assert.ok(Math.max(...derived.pixels.subarray(at,at+3)) < 200, 'edge now borrows its neighboring blue/purple color');
});

test('all legacy fallback densities retain transparency and complete original-canvas proportions', () => {
  for (const [density,size] of Object.entries(manifest.androidGeometry.legacySizes)) {
    const normal = readFileSync(join(icons, `android/mipmap-${density}/ic_launcher.png`));
    const round = readFileSync(join(icons, `android/mipmap-${density}/ic_launcher_round.png`));
    assert.ok(normal.equals(round));
    const { width, height, pixels } = rgbaPng(normal);
    assert.equal(width,size); assert.equal(height,size);
    assert.equal(pixels[3],0); assert.equal(pixels[(size*size-1)*4+3],0);
    let x0=size,y0=size,x1=0,y1=0; let solid=0;
    for (let y=0; y<size; y++) for (let x=0; x<size; x++) {
      const a=pixels[(y*size+x)*4+3]; if(a===255) solid++;
      if(a>=64) { x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x+1);y1=Math.max(y1,y+1); }
    }
    assert.ok(solid>size*size*0.3 && solid<size*size*0.65);
    assert.ok(Math.abs(x0/size-180/1254)<0.03); assert.ok(Math.abs(y0/size-137/1254)<0.03);
    assert.ok(Math.abs(x1/size-1070/1254)<0.03); assert.ok(Math.abs(y1/size-1051/1254)<0.03);
  }
  assert.equal(verifiedAndroidIcons(repo).size, 13);
});

test('high-resolution launcher artwork keeps every visible source pixel and the annotated perimeter', () => {
  const source=rgbaPng(readFileSync(join(icons,'luckyray-original.png')));
  const cleaned=rgbaPng(readFileSync(join(icons,'luckyray-android.png')));
  const packed=rgbaPng(readFileSync(join(icons,'android/drawable-nodpi/ic_launcher_artwork.png')));
  assert.equal(packed.width,926);assert.equal(packed.height,926);
  // Compare whole rows: no logo resampling, cover crop, matte or omitted edge.
  for(let y=0;y<926;y++) {
    const expected=cleaned.pixels.subarray(((y+128)*1254+177)*4,((y+128)*1254+1098)*4);
    const actual=packed.pixels.subarray((y*926+2)*4,(y*926+923)*4);
    assert.ok(actual.equals(expected),'complete source-content row must survive exactly');
  }
  for(let y=0;y<1254;y++) for(let x=0;x<1254;x++) {
    if(cleaned.pixels[(y*1254+x)*4+3]>=8) assert.ok(x>=177&&x<1098&&y>=128&&y<1054,'no visible authored content falls outside export');
  }
  for(const [x,y] of [[181,513],[185,513],[203,513],[650,138],[1067,600],[650,1047]]) {
    const from=(y*1254+x)*4;const to=((y-128)*926+x-177+2)*4;
    assert.equal(packed.pixels[to+3],source.pixels[from+3],'original perimeter alpha is never eroded or made opaque');
    assert.ok(packed.pixels.subarray(to,to+4).equals(cleaned.pixels.subarray(from,from+4)),'complete defringed perimeter survives export exactly');
    if(source.pixels[from+3]>=250) {
      assert.ok(packed.pixels.subarray(to,to+4).equals(source.pixels.subarray(from,from+4)),'authored nearly opaque blue-purple rim stays byte-identical');
    }
  }
  // The outer antialiasing sample has white-matted RGB; only its RGB is cleaned.
  const fringe=(513*1254+181)*4;const packedFringe=((513-128)*926+181-177+2)*4;
  assert.equal(source.pixels[fringe+3],227);
  assert.ok(!packed.pixels.subarray(packedFringe,packedFringe+3).equals(source.pixels.subarray(fringe,fringe+3)));
  assert.ok(packed.pixels[packedFringe]<source.pixels[fringe]);
  for(const [x,y] of [[0,0],[925,0],[0,925],[925,925]]) assert.equal(packed.pixels[(y*926+x)*4+3],0,'exterior stays transparent');
});

test('post-init removes only retired icon layers and rejects stale adaptive overrides', () => {
  const f = fixture();
  try {
    const retired = ['mipmap-anydpi-v26/ic_launcher.xml','mipmap-anydpi-v26/ic_launcher_round.xml',
      'mipmap-anydpi-v33/ic_launcher.xml','mipmap-anydpi-v33/ic_launcher_round.xml',
      'mipmap-xxxhdpi/ic_launcher_foreground.png','mipmap-mdpi/ic_launcher_background.png','values/ic_launcher_background.xml'];
    const untouched = join(f.res, 'values/unrelated.xml');
    for (const name of [...retired, 'values/unrelated.xml']) {
      const path = join(f.res, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'Tauri template');
    }
    applyAndroidIcons(f.root, f.android);
    for (const name of retired) assert.equal(existsSync(join(f.res, name)), false);
    assert.equal(readFileSync(untouched, 'utf8'), 'Tauri template');
    const stale = join(f.res, retired[0]); writeFileSync(stale, 'old adaptive wrapper');
    assert.throws(() => applyAndroidIcons(f.root, f.android, true), /Obsolete adaptive/);
    assert.equal(readFileSync(stale, 'utf8'), 'old adaptive wrapper');
    applyAndroidIcons(f.root, f.android);
    assert.equal(existsSync(stale), false);
  } finally { cleanup(f.root); }
});

test('both supported Android build launchers run the common post-init icon patch', () => {
  const read = path => readFileSync(join(repo, path), 'utf8');
  assert.match(read('scripts/apply-android-patches.sh'), /node "\$SCRIPT_DIR\/apply-android-icons\.mjs"/);
  for (const path of ['scripts/build-android-public.sh', 'scripts/build-android.ps1']) {
    const build = read(path); assert.ok(build.includes('android init')); assert.ok(build.includes('apply-android-patches.sh'));
  }
});
