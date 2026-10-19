import { useSyncExternalStore } from 'react';
import { editorToolbarPreferences } from './editorToolbarPreferences';
export function useToolbarPreferences() {
  return useSyncExternalStore(editorToolbarPreferences.subscribe, editorToolbarPreferences.getSnapshot, editorToolbarPreferences.getSnapshot);
}
