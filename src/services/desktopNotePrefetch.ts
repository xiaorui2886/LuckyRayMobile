import { api } from './client';
import { dataStore } from './dataStore';
import { NoteBodyPrefetch } from './noteBodyPrefetch';
export const desktopNotePrefetch = new NoteBodyPrefetch({
  read: (t,job) => api.contentNotePrefetch(t.instance,t.vault,t.id,t.revision,job),
  cancel: job => api.contentCancel(job),
  changed: () => dataStore.bump(),
});
