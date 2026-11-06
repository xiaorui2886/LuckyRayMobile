import './mobileGraph.css';

/** Shared by the lazy-route fallback and the first local snapshot load. */
export function MobileGraphLoading({ progress = '' }: { progress?: string }) {
  return <div className="mg-status mg-loading" role="status" aria-live="polite">
    <svg className="mg-loading-visual" width="104" height="88" viewBox="0 0 104 88" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.2" opacity=".28"><path d="M19 28 52 43 82 20M52 43 78 70M52 43 25 69M19 28 25 69M82 20 78 70" /></g>
      <g fill="currentColor"><circle cx="52" cy="43" r="6" /><circle cx="19" cy="28" r="4" /><circle cx="82" cy="20" r="4" /><circle cx="78" cy="70" r="4" /><circle cx="25" cy="69" r="3" /></g>
    </svg>
    <span>正在展开图谱</span>{progress && <span className="mg-loading-progress">{progress}</span>}
  </div>;
}
