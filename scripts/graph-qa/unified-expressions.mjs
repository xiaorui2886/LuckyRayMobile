/** Native production IPC only. No migration, mock transport or product test hooks. */
async function seed(localVaultId, prefix, count) {
  const invoke=window.__TAURI_INTERNALS__.invoke;
  const catalog=await invoke('managed_vault_list');
  const vault=catalog.items.find(v=>v.localVaultId===localVaultId);
  if(!vault||vault.binding||vault.migrationState!=='ready')throw Error('synthetic unbound ready vault required');
  const query={localVaultId,page:1,limit:100,sort:'name'};
  if((await invoke('managed_vault_note_list',{query})).total!==0)throw Error('empty fixture required; never reseed');
  for(let i=0;i<count;i++) {
    const title=prefix+'-'+String(i).padStart(3,'0');
    const next=prefix+'-'+String((i+1)%count).padStart(3,'0');
    await invoke('managed_vault_note_create',{localVaultId,title,content:['# '+title,'','[['+next+']]','Synthetic unified vault fixture.'].join('\n'),tags:['synthetic'],folder:''});
  }
  window.dispatchEvent(new Event('luckyray:managed-vault-change'));
  return invoke('managed_vault_note_list',{query});
}
export function seedUnifiedExpression(id,prefix,count=20) {
  if(typeof id!=='string'||!/^vault-[a-f0-9]{64}$/.test(id)||!/^Synthetic-[AB]$/.test(prefix)||!Number.isInteger(count)||count<2||count>100)throw Error('invalid synthetic seed bounds');
  return `(${seed.toString()})(${JSON.stringify(id)},${JSON.stringify(prefix)},${count})`;
}
