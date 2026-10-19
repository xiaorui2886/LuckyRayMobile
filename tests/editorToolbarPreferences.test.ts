import test from 'node:test';
import assert from 'node:assert/strict';
import { editorCommands } from '../src/presentation/still01/editor/editorCommands.ts';
import { normalizeToolbarPreferences, changeToolbarPreferences, toolbarCommands, createToolbarPreferencesStore, TOOLBAR_PREFERENCES_KEY } from '../src/presentation/still01/editor/editorToolbarPreferences.ts';
const defaults = normalizeToolbarPreferences(null);
test('defaults preserve every existing command in its exact order', () => {
  assert.deepEqual(toolbarCommands(defaults), editorCommands);
  for (const invalid of [null, false, 'text', { version: 2, order: ['bold'] }]) assert.deepEqual(normalizeToolbarPreferences(invalid), defaults);
});
test('normalization removes unknown/duplicate items and preserves newly available commands', () => {
  const value = normalizeToolbarPreferences({ version: 1, order: ['bold', 'bold', 'network-command'], hidden: ['redo', 'redo', 'network-command'] });
  assert.equal(value.order[0], 'bold'); assert.equal(value.order.length, editorCommands.length);
  assert.deepEqual(value.hidden, ['redo']); assert.equal(toolbarCommands(value)[0].command, 'bold');
});
test('hide/show is reversible and the last visible command cannot be hidden', () => {
  let value = defaults;
  for (const item of editorCommands) value = changeToolbarPreferences(value, item.command, 'hide');
  assert.equal(toolbarCommands(value).length, 1);
  const last = toolbarCommands(value)[0].command;
  assert.equal(changeToolbarPreferences(value, last, 'hide'), value);
  assert.deepEqual(normalizeToolbarPreferences({ ...defaults, hidden: defaults.order }).hidden, []);
  value = changeToolbarPreferences(value, 'bold', 'show'); assert.ok(toolbarCommands(value).some(item => item.command === 'bold'));
});
test('up/down skip hidden commands, preserve identities, and reject boundary moves', () => {
  const value = changeToolbarPreferences(defaults, 'redo', 'hide');
  const moved = changeToolbarPreferences(value, 'wiki', 'up');
  assert.deepEqual(toolbarCommands(moved).slice(0, 2).map(item => item.command), ['wiki', 'undo']);
  assert.deepEqual(changeToolbarPreferences(moved, 'wiki', 'down'), value);
  assert.equal(changeToolbarPreferences(moved, 'wiki', 'up'), moved);
  assert.equal(changeToolbarPreferences(moved, 'redo', 'up'), moved);
});
test('preference store persists only bounded command IDs and reloads exact display order', () => {
  const rows = new Map<string, string>(); const storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => { rows.set(key, value); } };
  const store = createToolbarPreferencesStore(storage); let changes = 0;
  const unsubscribe = store.subscribe(() => changes++);
  const value = changeToolbarPreferences(defaults, 'bold', 'hide');
  assert.equal(store.set({ ...value, content: 'private note', apiKey: 'do not store' }), true);
  assert.equal(changes, 1); store.set(value); assert.equal(changes, 1);
  assert.deepEqual(createToolbarPreferencesStore(storage).getSnapshot(), value);
  assert.equal(rows.size, 1); assert.equal(rows.get(TOOLBAR_PREFERENCES_KEY)?.includes('private'), false);
  unsubscribe(); store.set(defaults); assert.equal(changes, 1);
});
test('malformed or unavailable storage falls back safely and keeps in-session changes', () => {
  const malformed = createToolbarPreferencesStore({ getItem: () => '{bad', setItem: () => { throw Error('quota'); } });
  assert.deepEqual(malformed.getSnapshot(), defaults);
  const changed = changeToolbarPreferences(defaults, 'bold', 'hide');
  assert.equal(malformed.set(changed), false); assert.deepEqual(malformed.getSnapshot(), changed);
  assert.equal(createToolbarPreferencesStore().set(changed), false);
});
