// LocalSearchScreen (STITCH-R6) — 本地搜索.
//
// Visual source: R6 `function search()` — back header → search field → content
// rows; results carry a clear source tag so 笔记 / 素材 / 收集箱 are
// distinguishable at a glance.
//
// Behaviour source: production, unchanged. Dedicated three-domain local search
// opened from 首页 / 收集, using the same shared generation-safe
// `useUnifiedSearch` session as before.
import { useUnifiedSearch } from "../services/unifiedSearch";
import { searchResultKey } from "../services/searchContract";
import { IconFile, IconLink, IconNotes, IconSearch, IconText } from "../components/icons";
import { BackHeader, EmptyState, Row, RowArt, SearchField, SectionTitle } from "../components/ui";
import type { Tab } from "../App";

type Props = { onBack: () => void; go: (tab: Tab, detail?: string) => void };

export default function LocalSearchScreen({ onBack, go }: Props) {
  const { state, setQuery, loadMore } = useUnifiedSearch();
  const q = state.query.trim();

  return (
    <>
      <BackHeader title="搜索" onBack={onBack} />

      <SearchField
        value={state.query}
        onChange={setQuery}
        placeholder="搜索本地笔记、收集箱、素材…"
        autoFocus
      />

      {!q ? (
        <EmptyState
          icon={<IconSearch size={20} />}
          title="搜索手机上的内容"
          body="笔记、收集箱与本机素材都可以搜索，无需连接电脑。"
        />
      ) : state.loading && state.items.length === 0 ? (
        <EmptyState title="搜索中…" />
      ) : state.items.length === 0 ? (
        <EmptyState title="没有找到内容" body={`没有包含“${q}”的本地内容，换个关键词试试。`} />
      ) : (
        <>
          <SectionTitle title="结果" meta={state.total} />
          <div className="list">
            {state.items.map((res) => (
              <Row
                key={searchResultKey(res)}
                onClick={() => {
                  if (res.resultType === "note") go("knowledge", res.id);
                  else if (res.resultType === "asset") go("library", `local:${res.id}`);
                  else go("capture", res.id);
                }}
                leading={
                  <RowArt>
                    {res.resultType === "note" ? (
                      <IconNotes size={17} />
                    ) : res.resultType === "asset" ? (
                      <IconFile size={17} />
                    ) : res.kind === "link" ? (
                      <IconLink size={17} />
                    ) : (
                      <IconText size={17} />
                    )}
                  </RowArt>
                }
                title={res.title || "未命名"}
                meta={
                  (res.resultType === "note"
                    ? "笔记"
                    : res.resultType === "asset"
                      ? `素材 · ${res.kind}`
                      : `收集箱 · ${res.kind}`) + (res.snippet ? ` — ${res.snippet}` : "")
                }
              />
            ))}
          </div>
          {state.hasMore ? (
            <button className="quiet btn-block load-more" disabled={state.loading} onClick={loadMore}>
              {state.loading ? "加载中…" : "加载更多"}
            </button>
          ) : (
            <p className="list-foot">共 {state.total} 项</p>
          )}
        </>
      )}
    </>
  );
}
