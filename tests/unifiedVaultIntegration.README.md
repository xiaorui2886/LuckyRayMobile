# Unified vault integration evidence

## Executed locally (2026-10-26)

`LR_DOM_TEST_TOOLS=<pinned-jsdom-26.1.0-node_modules> node --test tests/unifiedVaultIntegration.dom.test.mjs`

Real `UnifiedNotesRoot`, `MobileGraphView`, selection store, catalog, managed service and graph builder are bundled. Only native IPC, navigation host, and Canvas rendering are replaced. Assertions check real node keys and editor routes, not text-only source regex.

- Empty catalog with old notes: no default legacy reader; opening setup never migrates/downloads/writes.
- Explicit create selects the new vault despite old migration status; does not prepare/commit migration.
- Same-name libraries with different desktop identity remain distinct. Exact desktop intent resolves B, even with native persisted A.
- Notes -> Graph -> Notes uses B's actual local body; graph key `note:mobile:b:shared-id`, editor route `vault:b:shared-id`; no desktop cache discovery.
- Switching A -> B before A resolves cannot publish A under B.
- An ambiguous duplicate exact binding makes current library read-only, revokes import ownership, and removes graph mutation controls.
- Missing current vault never silently falls back.

The readonly import assertion initially failed, exposing a real lifecycle gap. It passes after import ownership was fenced by catalog read-only / transfer state.

Independent existing regression rerun: `managedImportBridge.dom.test.mjs` PASS after fixing historical alias receipt auto-navigation. Existing bridge fixture now checks acknowledgement without navigation for unrelated old alias; current matching picker retains automatic navigation.

Node service regression: `feedbackCancellation`, `knowledgeVaultCatalog`, `mobileGraphSources`, `mobileGraphData`, `managedVaultMutations`: 50/50 PASS.

Endpoint recovery/client/connection/gateway files had no diff against c959eed at review time. This is source preservation, not fresh endpoint connectivity proof.

## Required native / device acceptance (not supplied by these fixtures)

- New install: select desktop vault -> metadata appears -> missing bodies remain read-only -> body download advances truthful progress -> ready body locally readable.
- Disconnect desktop/network: edit existing and create notes; restart app and retain content; reconnect -> upload exact binding -> verify actual desktop files.
- Simultaneous desktop/mobile edits preserve conflict and do not overwrite unrelated identity.
- Upgrade populated existing installation without implicit migration; preview/confirm one-time migration; retry interrupted operation without extra replicas or content loss.
- Two distinct same-name vaults, plus an already registered exact binding: repeated Add must not duplicate it; graph/search/editor remain on chosen identity.
- Pairing change/revocation and endpoint recovery after released native writer; no prior owner data uploads.
- Xiaomi 8 / 14U gestures, old WebView behavior, settings width, keyboard/safe-area, real frame performance.

No Android emulator, APK, LAN desktop, or user's physical device was exercised by this integration suite. Native IPC results are synthetic and must not be described as real sync or installation validation.
