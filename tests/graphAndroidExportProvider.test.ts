import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('Android export authority has a distinct non-exported component from capture',()=>{
  const patch=readFileSync(new URL('../scripts/apply-android-patches.sh',import.meta.url),'utf8');
  const declaration=patch.split('\n').find(line=>line.includes('grep -q "exportprovider"'))!;
  const component=declaration.match(/android:name="([^"]+)"/)?.[1];
  assert.ok(component,'export provider generation exists');
  assert.notEqual(component,'androidx.core.content.FileProvider','two authorities must not share the capture provider component identity');
  assert.match(declaration,/android:exported="false"/);
  assert.match(declaration,/android:grantUriPermissions="true"/);
  assert.match(declaration,/@xml\/export_file_paths/);
  const source=readFileSync(new URL('../scripts/android-src/ExportFileProvider.kt',import.meta.url),'utf8');
  assert.match(source,/class ExportFileProvider\s*:\s*FileProvider\(\)/);
  assert.match(patch,/cp "\$SRC_KOTLIN\/ExportFileProvider.kt" "\$DEST_KOTLIN\/ExportFileProvider.kt"/);
});
