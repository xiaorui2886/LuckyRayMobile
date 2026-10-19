import "./services/webviewCompatibility";
import React from "react";
import ReactDOM from "react-dom/client";
import "./design/tokens.css";
import "./app.css";
import App from "./App";
import { applyAppearance } from "./services/appearance";

// STITCH-R6: Interface Style (Quiet Dock / Content Ledger / Night Shelf) and
// Color Mode (Light / Dark) are Mobile-local presentation preferences applied
// as document attributes; CSS owns every visual difference between them.
applyAppearance();

// SERVICES-INTEGRATION-R2: the acceptance-only production Services driver owns
// the root ONLY in a build compiled with VITE_LUCKYRAY_SERVICES_ACCEPTANCE=1.
// The literal comparison (not the shared helper) is deliberate: vite statically
// replaces import.meta.env.* so a normal build folds this branch away and the
// driver module is never shipped; the acceptance APK is a release-mode bundle,
// so import.meta.env.DEV must NOT be the gate. Semantics stay in sync with
// servicesAcceptanceEnabled(), pinned by tests/servicesAcceptanceDriver.
if (import.meta.env.VITE_LUCKYRAY_SERVICES_ACCEPTANCE === "1") {
  import("./servicesAcceptance/AcceptanceDriver").then((m) => m.mountAcceptanceDriver());
} else {

// STILL-01.1 visual harness (?stillHarness=1, dev only): installs the mocked
// Tauri internals BEFORE the app boots so both sides of the parity harness
// render the same fixtures. Never loaded in normal launches.
const harnessBoot = new URLSearchParams(location.search).has("stillHarness")
  ? import("./still/harness").then((m) => m.installHarness())
  : Promise.resolve();

harnessBoot.then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
}
