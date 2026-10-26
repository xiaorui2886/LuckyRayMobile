import type { ManagedVault, VaultBinding } from './managedVault.ts';
import type { LibrarySelection, SavedLibrary } from './desktopLibraries.ts';
import { noteSourceKey, type NoteSourceSelection } from './noteSourceSelection.ts';

/** A device-local registry entry is the reading/writing authority. A remote
 * binding is its sync relationship, never a second browsing mode. Names are
 * deliberately excluded from all identity comparisons. This module is pure:
 * listing/resolving never creates a vault, downloads content or migrates data. */
export interface KnowledgeVaultEntry {
  id: string;
  localVaultId: string;
  name: string;
  displayName: string;
  binding: VaultBinding | null;
  readOnly: boolean;
  noteCount: number;
  statusLabel: string;
  detailLabel: string;
  ambiguousBinding: boolean;
  vault: ManagedVault;
}
export type KnowledgeVaultIssue = {
  kind: 'ambiguous-binding' | 'invalid-binding' | 'duplicate-local-id';
  localVaultIds: string[];
  message: string;
};
export interface KnowledgeVaultCatalog {
  items: KnowledgeVaultEntry[];
  selectedVaultId: string | null;
  selection: NoteSourceSelection | null;
  selectionState: 'ready' | 'empty' | 'needs-setup' | 'legacy' | 'missing' | 'ambiguous';
  issues: KnowledgeVaultIssue[];
}
export function knowledgeBindingKey(binding: VaultBinding | null | undefined): string | null {
  return binding && typeof binding.instanceId === 'string' && !!binding.instanceId
    && typeof binding.remoteVaultId === 'string' && !!binding.remoteVaultId
    ? JSON.stringify([binding.instanceId, binding.remoteVaultId]) : null;
}
export function buildKnowledgeVaultCatalog(
  catalog: { items: ManagedVault[]; selectedVaultId: string | null },
  selection: NoteSourceSelection | null = null,
): KnowledgeVaultCatalog {
  const issues: KnowledgeVaultIssue[] = [];
  const byId = new Map<string, ManagedVault[]>();
  for (const vault of catalog.items) {
    if (!vault.localVaultId || vault.migrationState !== 'ready' || vault.transferState === 'completed') continue;
    byId.set(vault.localVaultId, [...(byId.get(vault.localVaultId) || []), vault]);
  }
  const unique: ManagedVault[] = [];
  for (const [id, rows] of byId) {
    if (rows.length !== 1) { issues.push({kind:'duplicate-local-id',localVaultIds:[id],message:'知识库记录重复，请检查库详情。'}); continue; }
    unique.push(rows[0]);
  }
  const byBinding = new Map<string, string[]>();
  for (const vault of unique) {
    const key = knowledgeBindingKey(vault.binding);
    if (key) byBinding.set(key, [...(byBinding.get(key) || []), vault.localVaultId]);
    else if (vault.binding) issues.push({kind:'invalid-binding',localVaultIds:[vault.localVaultId],message:'此库的同步关联不完整，请检查库详情。'});
  }
  for (const ids of byBinding.values()) if (ids.length > 1) issues.push({kind:'ambiguous-binding',localVaultIds:ids,message:'多个知识库使用同一同步关联，请先核对，内容未合并。'});
  // Distinguish genuine same-name libraries without using their labels as
  // identity or exposing long machine identifiers in ordinary selectors.
  // Sort immutable local identities, not discovery/list order.
  const names = new Map<string, string[]>();
  for (const vault of unique) {
    const name = vault.name || '未命名知识库';
    names.set(name, [...(names.get(name) || []), vault.localVaultId]);
  }
  for (const ids of names.values()) ids.sort();
  const items: KnowledgeVaultEntry[] = unique.map(vault => {
    const bindingKey = knowledgeBindingKey(vault.binding);
    const ambiguousBinding = !!bindingKey && (byBinding.get(bindingKey)?.length || 0) > 1;
    const invalidBinding = !!vault.binding && !bindingKey;
    const readOnly = vault.transferState === 'pending' || ambiguousBinding || invalidBinding;
    const statusLabel = ambiguousBinding || invalidBinding ? '同步关联需检查'
      : vault.transferState === 'pending' ? '正在处理笔记' : vault.binding ? '已关联电脑同步' : '未开启同步';
    const name = vault.name || '未命名知识库';
    const peers = names.get(name)!;
    const ordinal = peers.length > 1 ? peers.indexOf(vault.localVaultId) + 1 : null;
    return {id:vault.localVaultId,localVaultId:vault.localVaultId,name,
      displayName:ordinal ? `${name}（${ordinal}）` : name,
      binding:vault.binding,readOnly,noteCount:vault.noteCount,statusLabel,
      detailLabel:`${ordinal ? `知识库 ${ordinal} · ` : ''}${statusLabel} · ${vault.noteCount} 篇笔记`,ambiguousBinding,vault};
  });
  const result: KnowledgeVaultCatalog = {items,selectedVaultId:null,selection,selectionState:'empty',issues};
  const select = (id: string) => {
    const item = items.find(vault => vault.id === id);
    if (!item) { result.selectionState = 'missing'; return; }
    result.selectedVaultId = id;
    result.selection = {kind:'managed',localVaultId:id};
    result.selectionState = item.ambiguousBinding ? 'ambiguous' : 'ready';
  };
  if (selection?.kind === 'managed') select(selection.localVaultId);
  else if (selection?.kind === 'legacy') result.selectionState = 'legacy';
  else if (selection?.kind === 'desktop') {
    const key = knowledgeBindingKey({instanceId:selection.instanceId,remoteVaultId:selection.vaultId});
    const matches = key ? byBinding.get(key) || [] : [];
    if (matches.length === 1) select(matches[0]);
    else result.selectionState = matches.length > 1 ? 'ambiguous' : 'needs-setup';
  } else if (catalog.selectedVaultId) {
    // An explicit persisted selection cannot silently fall back to another vault.
    result.selection = {kind:'managed',localVaultId:catalog.selectedVaultId};
    select(catalog.selectedVaultId);
  } else if (items.length) select(items[0].id);
  return result;
}

/** Only the Add/sync flow consumes these rows. They must not be appended to
 * the normal knowledge-library selector or rendered as a second graph source. */
export function availableDesktopVaults(catalog: KnowledgeVaultCatalog, state: LibrarySelection): SavedLibrary[] {
  if (!state.instance || state.catalog?.scopeSelectionVersion !== 1) return [];
  const registered = new Set(catalog.items.map(item => knowledgeBindingKey(item.binding)).filter((key): key is string => !!key));
  return state.catalog.knowledge.filter(row => !!row.vaultId && row.available && row.readGranted
    && !registered.has(knowledgeBindingKey({instanceId:state.instance,remoteVaultId:row.vaultId!})!));
}

export function sameKnowledgeVaultSelection(a: NoteSourceSelection | null, b: NoteSourceSelection | null): boolean {
  return a === b || !!a && !!b && a.kind === b.kind && noteSourceKey(a) === noteSourceKey(b);
}

export async function readKnowledgeVaultCatalog(selection: NoteSourceSelection | null = null): Promise<KnowledgeVaultCatalog> {
  const { managedVault } = await import('./managedVault.ts');
  return buildKnowledgeVaultCatalog(await managedVault.list(), selection);
}
