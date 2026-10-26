# Isolated installed-APK protocol peer

This is a **synthetic protocol peer**, not LuckyRay Desktop, a home LAN, Xiaomi hardware, or background/killed-app proof. It is only test infrastructure. No product command, TLS verifier, permissions, or APK DB is patched.

## Start (runner-owned temporary directory only)

Install the separately locked `scripts/graph-qa/tools` QA dependencies, then:

```sh
export UNIFIED_PEER_WS_MODULE="$PWD/scripts/graph-qa/tools/node_modules/ws/index.js"
node --test scripts/unified-vault-qa/synthetic-peer.test.mjs
node scripts/unified-vault-qa/synthetic-peer.mjs --runtime-dir "$RUNNER_TEMP/unified-peer" --port 17443
```

The server binds host `127.0.0.1`; the Android emulator uses its host alias `10.0.2.2`, not its own loopback. Fresh RSA certificate, pairing secret and bearer are generated for every run. Certificate lifetime is one day; runtime directory must be fresh. The APK receives the certificate's actual DER SHA256 fingerprint and uses the unchanged normal `conn_pair` TLS verifier. No manual CA trust or verification bypass is required.

`ready.json` describes runtime paths. `pairing.json`, key, certificate, runtime state and private server log must **never be published**. Copy only explicitly allowlisted `peer-evidence.json`, which omits headers, bodies and secrets. The harness saves this as `synthetic-peer-transport.json` and per-stage results as `synthetic-sync-checks.json`.

## Protocol / test boundaries

- Normal unauthenticated hello, one-time pair exchange, authenticated canonical session.
- Authenticated WSS foundation `/v1/events`, and services `/v1/services/events/stream`, ping/pong, typed knowledgeChanged hints. The library is read/write scoped; out-of-scope requests fail.
- Services library catalog, capabilities, vault list, metadata snapshot, durable changes, full note and body-hash replica manifest.
- Actual PATCH/POST/DELETE operations, expected-revision conflict, opId idempotency and full ACK document. Unsupported routes fail explicitly rather than fake success.
- Desktop addition is a fixed synthetic note, requested through a local runtime control file, not an unauthenticated HTTP admin API.
- Actual installed APK: wrong-pin rejection; normal native pairing; actual WSS connected event; **UI** Add Library enrollment; existing application foreground scheduling pulls notes; actual CodeMirror UI edit and autosave pushes to peer; native read-only assertions prove body and ACK state; Notes/Graph show the same managed library.
- No direct content_sync, database write, invented frontend state or fake Tauri invoke is used by the installed sync check. The repeat enrollment call only checks the real native command's idempotency after successful UI enrollment.
- Pair payload is supplied to the actual native command, not camera QR UI. Camera capture is not covered.
- Successful foreground scheduling does not establish killed-app/background sync. Successful protocol tests do not establish actual Desktop integration or home-network reachability.

## Prior first-pair failure: diagnostics, not an assumed root cause

The old APK and endpoint-recovery candidate both previously failed at `GatewayClient::hello → reqwest.send`, with no observed application HTTP on the Windows fixture. A host TLS test and shell/app-UID TCP connection did not prove the APK TLS handshake. That result does not identify TLS, firewall, proxy, routing or certificate parsing as the cause.

This fixture records TCP accepts, completed TLS handshakes, bounded TLS error codes, and HTTP method/path/status, separately. A negative-pin test is expected to increment TLS errors; subsequent successful pairing must still have hello→pair→session HTTP 200. If the APK fails, correlate these phases with package-only native error and AVD app state. Zero TCP accepts requires app/socket/proxy/routing diagnostics; accepted TCP with no successful TLS requires handshake evidence; successful TLS with no HTTP requires protocol/client diagnostics; HTTP replies require schema/status inspection. Do not weaken TLS/pinning, clear real user data, or call any stage successful merely because a lower layer worked.
