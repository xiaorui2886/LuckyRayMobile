type PrefetchTransport = {
    read: (target: BodyTarget, job: string) => Promise<{changed:boolean}>;
    cancel: (job: string) => Promise<unknown>;
    changed: () => void;
    now?: () => number;
};

export type BodyScope = { instance: string; vault: string };
export type BodyTarget = BodyScope & { id: string; revision: string };
const ownerKey = (s: BodyScope) => JSON.stringify([s.instance, s.vault]);
const key = (s: BodyTarget) => JSON.stringify([s.instance, s.vault, s.id, s.revision]);
/** Request receipts only. SQLite remains the sole body and draft authority. */
export class NoteBodyPrefetch {
  private scope = "";
  private queue: BodyTarget[] = [];
  private pending = new Map<string, {target:BodyTarget;job:string;promise:Promise<boolean>}>();
  private receipts = new Map<string, { at:number; ok:boolean }>();
  private sequence = 0;
  private generation = 0;
  private expected = new Map<string,string>();
  private transport: PrefetchTransport;
  constructor(transport: PrefetchTransport) { this.transport=transport; }
  private now() { return this.transport.now?.() ?? Date.now(); }
  setVisible(scope: BodyScope, targets: BodyTarget[], active: boolean) {
    const next = ownerKey(scope);
    if (next !== this.scope) {
      this.scope=next; this.queue=[]; this.generation++; this.receipts.clear(); this.expected.clear();
      for (const p of this.pending.values()) void this.transport.cancel(p.job).catch(()=>{});
    }
    // A covered list stops queued work; two existing exact-owner reads may
    // finish so opening details can await rather than duplicate them.
    for(const t of targets) this.expected.set(JSON.stringify([t.instance,t.vault,t.id]),t.revision);
    while(this.expected.size>128)this.expected.delete(this.expected.keys().next().value!);
    this.queue=active ? targets.filter(t=>ownerKey(t)===next).slice(0,12) : [];
    this.pump();
  }
  suspend() {
    this.queue=[]; this.generation++;
    for(const p of this.pending.values()) void this.transport.cancel(p.job).catch(()=>{});
  }
  async waitFor(instance:string,vault:string,id:string):Promise<{revision:string}|null> {
    const identity=JSON.stringify([instance,vault,id]), revision=this.expected.get(identity);
    if(revision===undefined)return null;
    const p=this.pending.get(JSON.stringify([instance,vault,id,revision]));
    const ok=p ? await p.promise : (()=>{const r=this.receipts.get(JSON.stringify([instance,vault,id,revision]));return Boolean(r?.ok&&this.now()-r.at<30_000)})();
    return ok&&this.expected.get(identity)===revision ? {revision} : null;
  }
  private pump() {
    while(this.pending.size<2&&this.queue.length) {
      const target=this.queue.shift()!, k=key(target), old=this.receipts.get(k);
      if(this.pending.has(k)||old&&this.now()-old.at<(old.ok?30_000:10_000))continue;
      const generation=this.generation;
      const job=`note-prefetch-${this.now()}-${++this.sequence}`;
      const promise=Promise.resolve().then(()=>generation===this.generation ? this.transport.read(target,job) : {changed:false}).then(result=>{
        if(generation!==this.generation||ownerKey(target)!==this.scope)return false;
        if(result.changed)this.transport.changed();
        this.receipts.set(k,{at:this.now(),ok:result.changed});return result.changed;
      }).catch(()=>{if(generation===this.generation)this.receipts.set(k,{at:this.now(),ok:false});return false;}).finally(()=>{
        this.pending.delete(k);
        while(this.receipts.size>128)this.receipts.delete(this.receipts.keys().next().value!);
        this.pump();
      });
      this.pending.set(k,{target,job,promise});
    }
  }
}
