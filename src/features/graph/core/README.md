# Shared desktop graph core

Source: LuckyRay desktop `xiaorui2886/luckyray-app` at commit `200433932c465ea26b16e8e4fa272507ce692388`.

Byte-identical ports: graphCamera.ts, graphPhysics.ts, graphPhysics.worker.ts, graphPresentation.ts, graphSpatial.ts, graphPlayback.ts, wikiTargets.ts. graphPlaybackSession.ts changes only host imports to portable local imports.

Extracted pure logic: graphSemantics.ts (GraphPage scene filtering, search, colors, actual defaults, force mappings and relationship eligibility), graphRenderer.ts (arrow/edge/node paint math and playback camera follow). graphTypes.ts carries the desktop GraphSeed schema with optional mobile-local path metadata. They have no network, model, desktop bridge, filesystem writes, or React dependencies.

Coordinate contracts: physics uses world coordinates; camera pan is screen pixels; scale .025–12. Node IDs are seed-local, stable keys identify retained state. GraphSettings from normalizeGraphView uses actual saved-view initialization defaults .45 labelReveal and 180 linkLength, not obsolete intermediate constants. Renderer uses graphScreenRadius separately from world collision radii. `filteredGraph.visibleNodes` includes nodes marked hidden, mirroring desktop; render `renderedNodes` and `renderedEdges` or check hidden explicitly. Color-group matching uses all seed tag edges, even when tag nodes are filtered out.

Tests: Node 24 `node --test tests/graph-core/*.test.ts`. The source-history-dependent desktop playback test was replaced with portable behavior tests; no private Git history required. Desktop presentation tests retain pure label/filter checks, while mobile host owns vault-scoped persistence tests.

Dependencies: d3-force 3.0.0, @types/d3-force 3.0.10. See `third-party/graph-d3.txt` for upstream license notices. The package does not load Obsidian code.
