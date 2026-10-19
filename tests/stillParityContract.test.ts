// tests/stillParityContract.test.ts — STILL-01.1 parity rebuild guards.
//
// Deterministic contracts for [STILL-01.1-PARITY-REBUILD-R1]:
//   1. source fidelity: the ui/* production copies are byte-frozen to the
//      design/still-01-1-authority @17039ea blobs (SHA256 digests recorded
//      from the staged authority — never re-derived from the working tree);
//   2. legacy presentation is NOT rendered: App.tsx and the Still shell must
//      not import or mount any legacy screen/navigation surface;
//   3. the Still tree is structurally in place: .st-app shell, PageLayer,
//      TabBar/HomeCapture, still.css, overlayStack-backed sheets;
//   4. the contract itself is registered in CI Lite.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---- 1. authority source fidelity ------------------------------------------
// Digests recorded from design/still-01-1-authority @17039ea
// (git show design/still-01-1-authority:design/still-01-1/ui/<file> | sha256sum).
// The zip-variant discrepancy (source-only vs full package) was reported to
// the controller; these are the STAGED blobs this branch is held to.
//
// UX-POLISH-R1 (Issue #78) is the one sanctioned drift: the task card
// explicitly orders the Home connection row, icon-only bottom nav, the
// rounded pin/heart note flags, the note-row metadata layout, the asset
// favorite action and the AI LightSeek panel, all of which live in these
// three files. Still.tsx / Views.tsx / still.css therefore moved to their
// post-R1 digests; tokens.json remains on the original staged digest. The
// current materials exception below advances only PageLayer.tsx/still.css.
// The contract still pins exact bytes so any
// FUTURE unauthorised drift keeps failing here.
//
// SERVICES-ASSET-DETAIL-R1: still.css advanced again — an APPEND-ONLY block
// (.st-asset-source*) for the ordinary desktop-asset source section + 在电脑打开.
// No pre-existing rule was modified; every accepted #78 selector is untouched.
const AUTHORITY_DIGESTS: Record<string, string> = {
  // MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R7c: Row no longer renders a default
  // left placeholder slot (the original behaviour; the material list now
  // requests its slot explicitly via reserveThumbSlot).
  // CM6-EDITOR-R1: Still.tsx gains the OPTIONAL bodyEditor slot (the
  // textarea remains byte-intact as the fallback branch; the autoFocus
  // effect only owns the textarea branch). still.css gains one APPEND-ONLY
  // block scoping the CM adapter to the original paper look.
  // TAP-EDIT-R1: user-requested NoteSurface title/body entry and removal of
  // duplicate Edit/Done controls. Only this component and its helper import
  // change; other authority components and stylesheet remain byte-identical.
  // MOBILE-NAVIGATION-REPAIR: scoped NoteSurface strip/navigation and focus hooks.
  "Still.tsx": "3ddfa4ad4ea98e9640056b043f403d4925be0870b29498f0e9aaf319270d2750",
  // MATERIAL-LIBRARY-INSTANT-R1 REPAIR-R7b: Views.tsx advanced to forward the
  // drag-end hook to both layouts (the auto-scroll stop signal).
  // SERVICES-KNOWLEDGE-BROWSE-R1 REPAIR-R1/R2: the desktop new-affordance is
  // genuinely disabled (any domain), the desktop knowledge hides the inert
  // sort affordance, and the status + bounded load-more moved INSIDE the
  // scroll as CollectionView slots (the toolbar label is the vault only).
  // KNOWLEDGE-ORGANIZATION-R1 REPAIR-R1.1: the desktop Knowledge note rows
  // render through the shared KnowledgeNoteRow (the ONE #85 gesture adapter
  // + data-note-id hit targets) when the page passes selection props, and
  // the selection bar's action label is overridable (default stays 整理所选).
  // Plain rows and the local composition are byte-unchanged.
  // REPAIR-R1.5: NoteItem gains OPTIONAL literal search-hit fields
  // (titleHit/bodyHitLine) rendered as React segments by both row paths —
  // no HTML injection, plain rows unchanged when the fields are absent.
  // #97 MOBILE MATERIALS: optional footer inside the existing scroll and
  // truthful local/desktop material cold-copy only. Note paths unchanged.
  // MOBILE-NAVIGATION-REPAIR: optional hidden context label for folder view only.
  "Views.tsx": "af42df8b29ca0dc525efd8e757a700cde418ef4ca0505220e7e6731ed38e573b",
  // MATERIALS-PLAYBACK-UX 732dc75, independently reviewed at bc84deb:
  // optional masked retained layer (never a destroyed list) prevents old
  // Android compositors painting inactive captions through settled detail.
  "PageLayer.tsx": "1456a9ef2b45d8224db57979b2244dd99c0e9ad4e1f28ff3ab2c41f47eb173a8",
  // SERVICES-KNOWLEDGE-BROWSE-R1 REPAIR-R1: the real Desktop knowledge status
  // line (st-kb-status) + the local rows keep their own filter/sort.
  // KNOWLEDGE-ORGANIZATION-R1 REPAIR-R1.1: an APPEND-ONLY block for the
  // Knowledge note-row selection treatment (.st-note-row.is-selecting /
  // .st-note-check) — the same restrained check language the tiles use. No
  // pre-existing rule was modified.
  // REPAIR-R1.5: another APPEND-ONLY block for the literal search-hit
  // presentation (.st-hit / .st-note-hit / .st-note-nomatch).
  // REPAIR-R1.6: the .st-hit rule itself was strengthened (a real accent
  // background with theme-scoped high-contrast ink, small radius/padding —
  // the literal React-segment architecture is unchanged).
  // Same 732dc75 reviewed materials delta: scoped retained-layer mask,
  // compact source/full Info actions, old-WebView margin spacing and bounded
  // caption/feedback. No other authority digest is advanced by this batch.
  // #97: material-only stable source/caption geometry, bounded decode
  // feedback/footer, enlarged-text fit verified through the real page.
  "still.css": "b7638868ab30c35e9c9aeacfad87efd58499e95a0f806b438cb55b3cc94ab2a7",
  "tokens.json": "61d98522d6edf1d95a857d5e0ee1da32fbe97518e5f65971a51a3327a5217d6a",
};

// User-authorized folder/wiki/backlink navigation appends one scoped block.
// Keep the entire accepted stylesheet prefix pinned to its PRE-navigation
// digest; do not bless an unrelated edit by regenerating that authority hash.
const NAVIGATION_CSS_BOUNDARY = "\n/* Read-only desktop knowledge navigation; uses the existing Still type/color scale. */";

test("still parity — authority copies preserve the staged design blobs", () => {
  for (const [file, digest] of Object.entries(AUTHORITY_DIGESTS)) {
    const source = read("src", "presentation", "still01", file);
    const boundary = file === "still.css" ? source.indexOf(NAVIGATION_CSS_BOUNDARY) : -1;
    if (file === "still.css") assert.ok(boundary > 0, "the authorized append-only navigation boundary exists");
    // User screenshot request 2026-10-09 explicitly replaces NoteSurface
    // chrome, read toggle and command icons. Pin that bounded component plus
    // the untouched prefix independently; do not bless other kit changes.
    if (file === "Still.tsx") {
      const marker = "export type NoteState=";
      const split = source.indexOf(marker); assert.ok(split > 0);
      const prefix = source.slice(0, split).replace("iconPaths[name]||noteActionPaths[name as keyof typeof noteActionPaths]||iconPaths.file", "iconPaths[name]||iconPaths.file").replace("import { NoteActionIcon, noteActionPaths } from './editor/NoteActionIcon';\n", "").replace("danger=false,icon,iconSlot}:{label:string;", "danger=false,icon}:{label:string;").replace("danger?:boolean;icon?:string;iconSlot?:ReactNode}", "danger?:boolean;icon?:string}").replace("{iconSlot??(icon&&<Icon name={icon} size={19}/>)}", "{icon&&<Icon name={icon} size={19}/>}");
      assert.equal(sha256(prefix), "39dd376a6e00119b35488010e48a964a33075493d33b9b9bc5d0e233e445e3cc");
      assert.equal(sha256(source.slice(split)), "513304ba62c9fa4e5e93175646f1f9f10a58f1633676138a2822047a13018b90");
      continue;
    }
    const liveCurrentBlock = "\n// Paint may be retained; whether this page can act must remain live.\nconst PageCurrentContext=createContext<boolean|undefined>(undefined);\nexport function usePageCurrent(fallback=true):boolean {\n return useContext(PageCurrentContext)??fallback;\n}\nexport function useRetainedPage():boolean {\n return useContext(PageCurrentContext)!==undefined;\n}\n";
    let pinned = boundary < 0 ? source : source.slice(0, boundary);
    if (file === "PageLayer.tsx") {
      assert.equal(source.split(liveCurrentBlock).length, 2, "one exact scoped live-currentness addition");
      assert.equal(source.split('<PageCurrentContext.Provider value={current&&!leaving}>').length, 2);
      assert.equal(source.split('</PageCurrentContext.Provider>').length, 2);
      pinned = source.replace(liveCurrentBlock, "")
        .replace("{createContext, useContext, useLayoutEffect", "{useLayoutEffect")
        .replace('<PageCurrentContext.Provider value={current&&!leaving}>', "")
        .replace('</PageCurrentContext.Provider>', "");
    }
    if (file === "Views.tsx") {
      // UI R3: knowledge-only row layout scope and document symbols; library untouched.
      pinned = pinned.replace('className={"st-view"+(!library?" st-knowledge-view":"")}', 'className="st-view"')
        .replaceAll('<span className="st-knowledge-note-symbol" aria-hidden="true"><Icon name="file" size={20}/></span>', '');
    }
    const actual = sha256(pinned);
    assert.equal(actual, digest, `${file} drifted from the staged authority blob`);
  }
});

test("still parity — the appended navigation styles cannot override unrelated authority selectors", () => {
  const css = read("src", "presentation", "still01", "still.css");
  assert.equal(css.split(NAVIGATION_CSS_BOUNDARY).length, 2, "one appended navigation block");
  const appended = css.split(NAVIGATION_CSS_BOUNDARY)[1].split("/* Navigation repair:")[0].replace(/\/\*[\s\S]*?\*\//gu, "");
  assert.doesNotMatch(appended, /@|url\(/u, "no imports, external resources, or unscoped at-rules");
  const allowed = new Set([
    "st-folder-breadcrumbs", "st-folder-row", "st-folder-status", "st-folder-notes-label", "st-folder-pick",
    "st-wiki-link", "st-note-relations", "st-relations-toggle", "st-relations-refresh", "st-relation-row",
    "st-relations-notice", "st-relations-picker",
  ]);
  const rules = [...appended.matchAll(/([^{}]+)\{([^{}]*)\}/gu)];
  assert.ok(rules.length > 0, "navigation has a nonempty scoped style block");
  assert.equal(appended.replace(/([^{}]+)\{([^{}]*)\}/gu, "").trim(), "", "every appended rule is checked");
  for (const [, selectorList] of rules) for (const selector of selectorList.split(",")) {
    // Only these navigation roots, their current states and small child tags
    // may be styled. Sibling combinators cannot escape into another surface.
    const root = selector.trim().match(/^\.([a-z-]+)(?:(?::(?:active|focus-visible|disabled))|(?:\s+|>)(?:button|span|small|strong)(?::(?:disabled|last-child|nth-child\(2\)))?)?$/u)?.[1];
    assert.ok(root && allowed.has(root), `unapproved authority override in appended selector: ${selector}`);
  }
});

// ---- 2. legacy presentation never renders -----------------------------------
test("still parity — App.tsx renders only the Still tree (no legacy screens)", () => {
  const appTsx = read("src", "App.tsx");
  assert.doesNotMatch(appTsx, /from "\.\/screens\//, "no legacy screen imports in the app root");
  assert.doesNotMatch(appTsx, /BottomNav|ComposeFab|<DetailShell|<ToastHost|className="app-shell"/,
    "legacy nav/FAB/shell/hosts are gone from the rendered tree");
  assert.match(appTsx, /return <StillApp conn=\{conn\} editingText=\{editingText\} \/>;/,
    "the Still shell is the only product render");
  assert.match(appTsx, /StillHealthRecovery/, "the health gate uses the Still recovery surface");
});

test("still parity — the Still shell imports no legacy screens", () => {
  const shellTsx = read("src", "still", "StillShell.tsx");
  assert.doesNotMatch(shellTsx, /from "\.\.\/screens\//, "the shell must not source DOM from legacy screens");
  // Sanctioned logic-sourcing elsewhere (pure helpers only, never DOM):
  // src/still/StillInbox.tsx imports displayTitle/kindLabel from screens/Inbox,
  // src/still/StillAsset.tsx imports CachedMedia (media element) and
  // contentError. Those files never render legacy screen surfaces.
});

test("still parity — still screens never emit legacy selectors", () => {
  const files = [
    "StillShell.tsx", "StillHome.tsx", "StillLibrary.tsx", "StillCollection.tsx",
    "StillAgent.tsx", "StillSettings.tsx", "StillConnect.tsx", "StillCapture.tsx",
    "StillInbox.tsx", "StillAsset.tsx", "StillSearch.tsx", "StillNote.tsx",
  ];
  for (const f of files) {
    const s = read("src", "still", f);
    assert.doesNotMatch(s, /className="[^"]*(bottom-nav|compose-fab|app-shell|screen-area|editor-title|editor-body|back-header)/,
      `${f} renders a legacy selector`);
  }
});

// ---- 3. Still tree structure -------------------------------------------------
test("still parity — the .st-app shell wires the authority kit", () => {
  const shellTsx = read("src", "still", "StillShell.tsx");
  assert.match(shellTsx, /import "\.\.\/presentation\/still01\/still\.css";/, "authority stylesheet loaded");
  assert.match(shellTsx, /<PageLayer/, "retained detail layers render through PageLayer");
  assert.match(shellTsx, /<HomeCapture root=\{rootTab\}/, "home-only compose action");
  assert.match(shellTsx, /<TabBar value=\{rootTab\}/, "Still dock");
  assert.match(shellTsx, /data-mode=\{mode\}/, "light/dark axis");
  assert.match(shellTsx, /data-reduced=\{reduced \? "true" : undefined\}/, "reduced-motion axis");
  assert.match(shellTsx, /dataset\.density = w <= 360 \? "compact" : w >= 520 \? "wide" : "regular"/,
    "density axis matches the authority derivation");
  assert.match(shellTsx, /registerOverlay: \(dismiss\) => overlayStack\.push\(dismiss\)/,
    "sheets join the production Back chain via overlayStack");
});

test("still parity — every root renders an authority View", () => {
  const shellTsx = read("src", "still", "StillShell.tsx");
  for (const [cond, view] of [
    ['rootTab === "home"', "StillHome"],
    ['rootTab === "knowledge"', "StillKnowledge"],
    ['rootTab === "ai"', "StillAgent"],
  ] as const) {
    assert.match(shellTsx, new RegExp(`${cond.replace(/"/g, '"')} [?:] <${view}`), `${view} is routed for its root`);
  }
  assert.match(shellTsx,/libraryVisited\.current \? <div key="retained-library" hidden=\{rootTab !== "library"\}/,"#97 retains only the visited Library and hides it on other roots");
  assert.match(shellTsx,/<StillLibrary conn=\{conn\} active=\{rootTab === "library"\} \/>/,"the sole material root receives its actual activity boundary");
  assert.match(shellTsx, /: <StillSettingsRoot/, "settings root falls through to StillSettingsRoot");
  const noteTsx = read("src", "still", "StillNote.tsx");
  assert.match(noteTsx, /<NoteSurface/, "notes render the authority NoteSurface");
  assert.match(noteTsx, /LocalNoteAutosaveCoordinator/, "local autosave authority preserved");
  assert.match(noteTsx, /contentNoteBegin/, "desktop epoch/generation editor preserved");
});

// ---- 4. CI registration ------------------------------------------------------
test("still parity — this contract is registered in CI Lite", () => {
  const ci = read(".github", "workflows", "ci-lite.yml");
  assert.match(ci, /tests\/stillParityContract\.test\.ts/, "explicit CI file list includes this contract");
});

// User-requested folder/toolbar repair owns only its separately appended suffix.
// Exact hash prevents silently expanding selector scope during later work.
test("navigation repair style suffix remains reviewed and exact", () => {
  const css = read("src", "presentation", "still01", "still.css");
  const suffix = css.slice(css.indexOf("/* Navigation repair:"));
  // Browser repair: only the editor strip gains horizontal overscroll containment.
  assert.equal(sha256(suffix), "8001098ab1a0402be0393b5f6c1a7b00af522ec18d1f8f2b6a72599a6823b644");
});
