/** QA-only expression factories. They invoke existing native APIs, never install a product hook. */
async function initializeEmptySyntheticVault() {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const catalog = await invoke('managed_vault_list');
  if (catalog.items.some(v => v.binding)) throw Error('bound vault forbidden');
  const status = await invoke('managed_vault_migration_status');
  if (status.state === 'ready') throw Error('fresh empty profile required');
  const prep = await invoke('managed_vault_migration_prepare');
  if (prep.state !== 'prepared' || prep.noteCount !== 0 || prep.localVaultId !== 'local' || typeof prep.planId !== 'string' || !prep.planId) throw Error('nonempty or invalid synthetic migration plan');
  return invoke('managed_vault_migration_commit', { planId: prep.planId });
}
async function seedSyntheticNotes(count, start = 0, end = count) {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const list = await invoke('managed_vault_list');
  const vault = list.items.find(v => v.localVaultId === 'local' && !v.binding && v.migrationState === 'ready');
  if (!vault) throw Error('local vault missing');
  const query = { localVaultId: vault.localVaultId, limit: 1, page: 1 };
  const old = await invoke('managed_vault_note_list', { query });
  if (start === 0 && old.total !== 0) throw Error('nonempty vault forbidden');
  if (old.total !== start) throw Error('unexpected synthetic chunk boundary; no retry or duplicate writes allowed');
  for (let i = start; i < end; i++) {
    const title = 'Synthetic-' + String(i).padStart(4, '0');
    const next = 'Synthetic-' + String((i + 1) % count).padStart(4, '0');
    // No nested template escaping: LF is explicitly constructed in the evaluated runtime.
    const content = ['# ' + title, '', '[[' + next + ']]', 'Synthetic graph fixture only.'].join(String.fromCharCode(10));
    await invoke('managed_vault_note_create', { localVaultId: vault.localVaultId, title, content, tags: ['synthetic', 'group-' + i % 5], folder: '' });
  }
  window.dispatchEvent(new Event('luckyray:managed-vault-change'));
  return (await invoke('managed_vault_note_list', { query })).total;
}
export function initializeExpression() { return `(${initializeEmptySyntheticVault.toString()})()`; }
export function seedExpression(count = 1000) {
  if (!Number.isInteger(count) || count < 20 || count > 5000) throw Error('synthetic fixture size must be 20..5000');
  return `(${seedSyntheticNotes.toString()})(${JSON.stringify(count)})`;
}

export function seedChunkExpression(count, start, size = 25) {
  if (!Number.isInteger(count) || count < 20 || count > 5000 || !Number.isInteger(start) || start < 0 || start >= count || !Number.isInteger(size) || size < 1 || size > 50) throw Error('invalid synthetic chunk bounds');
  return `(${seedSyntheticNotes.toString()})(${count},${start},${Math.min(count,start+size)})`;
}
