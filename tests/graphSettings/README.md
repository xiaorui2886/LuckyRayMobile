# Mobile graph settings checks

Uses the actual production settings component and stylesheet with synthetic state only.
No connected phone, native bridge, or user data is used.

```sh
LR_DOM_TEST_TOOLS=/absolute/path/to/pinned-jsdom-26.1.0/node_modules \
  node tests/graphSettings/mobileGraphSettings.dom.test.mjs
```

The DOM suite verifies every settings family, collapse/ARIA relationships,
color-group order and 16-group limit, sliders, playback/reset, the existing
one-opening autofocus contract, fresh back callbacks, and trigger-focus restore.

The browser suite needs an already running supported Chromium CDP endpoint and Vite:

```sh
node tests/graphSettings/MobileGraphSettings.browser.test.mjs \
  http://127.0.0.1:9224 http://127.0.0.1:1423 /tmp/graph-settings-evidence
```

It checks 320/360/430-pixel phone widths, landscape, a short native-resized keyboard
viewport, compact drawer bounds and a visible graph corridor, fixed heading, scroll reachability of the final
force control, 44-pixel targets, dark mode, rounded source focus, and both OS/app
reduced-motion paths. The optional evidence directory receives screenshots and JSON.
Browser emulation is not evidence of physical Android keyboard/lifecycle behavior.

## Notes/Graph source handoff hook harness

```sh
LR_DOM_TEST_TOOLS=/absolute/path/to/pinned-jsdom-26.1.0/node_modules \
  node tests/graphSettings/noteGraphSourceHandoff.dom.test.mjs
```

This test extracts the actual private `LegacyStillKnowledge` source-handoff hooks
and manual library-selection callback into a React harness, with a deferred
library-authority seam. It covers pending B versus previously selected A, successful
and failed handoff, cancellation by a newer local choice, mismatched owners,
manual C success/failure while B is pending, and unpaired Desktop intent.
It checks production hook decisions and callback fencing—not full Notes rendering,
native invalidation, on-device UI, or the native library-switch authority.
