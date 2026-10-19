import { editorCommands, type EditorCommand } from './editorCommands.ts';

export type ToolbarPreferences = Readonly<{ version: 1; order: readonly EditorCommand[]; hidden: readonly EditorCommand[] }>;
export const TOOLBAR_PREFERENCES_KEY = 'luckyray.note.toolbar.v1';
const defaults = editorCommands.map(item => item.command);
const known = new Set<string>(defaults);
export function normalizeToolbarPreferences(input: unknown): ToolbarPreferences {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const valid = value.version === 1;
  const unique = (items: unknown): EditorCommand[] => Array.isArray(items)
    ? [...new Set(items.filter((x): x is EditorCommand => typeof x === 'string' && known.has(x)))] : [];
  const order = valid ? unique(value.order) : [];
  for (const command of defaults) if (!order.includes(command)) order.push(command);
  const hidden = valid ? unique(value.hidden) : [];
  return Object.freeze({ version: 1, order: Object.freeze(order), hidden: Object.freeze(hidden.length === defaults.length ? [] : hidden) });
}
export function toolbarCommands(preferences: ToolbarPreferences) {
  return preferences.order.filter(command => !preferences.hidden.includes(command))
    .map(command => editorCommands.find(item => item.command === command)!);
}
export function changeToolbarPreferences(value: ToolbarPreferences, command: EditorCommand, action: 'up' | 'down' | 'hide' | 'show'): ToolbarPreferences {
  if (!known.has(command)) return value;
  const order = [...value.order], hidden = [...value.hidden];
  const visible = order.filter(item => !hidden.includes(item));
  if (action === 'hide') {
    if (visible.length <= 1 || hidden.includes(command)) return value;
    hidden.push(command);
  } else if (action === 'show') {
    const index = hidden.indexOf(command); if (index < 0) return value;
    hidden.splice(index, 1);
  } else {
    const index = visible.indexOf(command), next = index + (action === 'up' ? -1 : 1);
    if (index < 0 || next < 0 || next >= visible.length) return value;
    const a = order.indexOf(command), b = order.indexOf(visible[next]);
    [order[a], order[b]] = [order[b], order[a]];
  }
  return normalizeToolbarPreferences({ version: 1, order, hidden });
}
export type ToolbarStorage = Pick<Storage, 'getItem' | 'setItem'>;
/** Presentation preference only. Never stores document text, selections, keys or credentials. */
export function createToolbarPreferencesStore(storage?: ToolbarStorage) {
  const read = () => { try { return normalizeToolbarPreferences(JSON.parse(storage?.getItem(TOOLBAR_PREFERENCES_KEY) ?? 'null')); } catch { return normalizeToolbarPreferences(null); } };
  let snapshot = read();
  const listeners = new Set<() => void>();
  function publish(next: ToolbarPreferences) {
    if (JSON.stringify(snapshot) === JSON.stringify(next)) return;
    snapshot = next; for (const listener of listeners) listener();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh: () => publish(read()),
    set(value: unknown): boolean {
      const next = normalizeToolbarPreferences(value); let persisted = false;
      try { if (storage) { storage.setItem(TOOLBAR_PREFERENCES_KEY, JSON.stringify(next)); persisted = true; } } catch { /* session preference remains usable */ }
      publish(next); return persisted;
    },
  };
}
const storage = (() => { try { return globalThis.localStorage; } catch { return undefined; } })();
export const editorToolbarPreferences = createToolbarPreferencesStore(storage);
