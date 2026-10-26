// Browser-only synthetic native seam. Never imported by the application entry.
import React from "react";
import { createRoot } from "react-dom/client";
import { EndpointRecovery } from "../../src/still/EndpointRecovery";
import "../../src/presentation/still01/still.css";
import "../../src/presentation/still01/defaultTheme.css";
import "../../src/still/settingsPages.css";

const fixture = { calls: [] as string[], outcome: "success", updated: 0, dismiss: null as null | (() => void) };
Object.assign(window, { __recoveryFixture: fixture, __TAURI_INTERNALS__: {
  invoke: async (command: string) => {
    fixture.calls.push(command);
    if (command === "conn_endpoint_prepare") return {
      prepareId: "00000000-0000-4000-8000-000000000001", verification: "not_yet_verified",
      currentBaseUrl: "https://192.168.1.20:7303", candidateBaseUrl: "https://192.168.1.20:12345",
      displayName: "合成测试电脑 Synthetic Desktop", fingerprintSummary: "00000000…0000",
    };
    if (command === "conn_endpoint_update") {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (fixture.outcome !== "success") throw "ENDPOINT_TLS_FAILED";
      return { status: "updated", baseUrl: "https://192.168.1.20:12345", requiresReconnect: true };
    }
    if (command === "conn_endpoint_cancel") return { status: "cancelled" };
    throw new Error("Unexpected browser fixture command");
  },
} });
createRoot(document.getElementById("root")!).render(<React.StrictMode>
  <div className="st-app" data-mode="light" data-reduced="true">
    <div className="st-settings-overlay-scope"><div className="st-view st-settings-page st-settings-connect"><div className="st-scroll">
      <EndpointRecovery registerOverlay={fn => { fixture.dismiss = fn; return () => { fixture.dismiss = null; }; }} onUpdated={() => ++fixture.updated} />
    </div></div></div>
  </div>
</React.StrictMode>);
