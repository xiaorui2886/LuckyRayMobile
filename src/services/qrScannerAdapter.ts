// QrScannerAdapter — single QR scanning entry point for pairing UI.
//
// The React layer only knows this interface; the underlying implementation is
// chosen by capability:
//   1. native  — CameraX + bundled ML Kit via the Rust bridge (qr_scan).
//                Works on devices WITHOUT Google Play Services (model ships in
//                the APK). This is the primary path for Android Alpha.
//   2. plugin  — tauri-plugin-barcode-scanner (unbundled ML Kit, needs GMS).
//                Kept as a fallback on GMS devices.
//
// The native path is preferred because no-GMS devices (Chinese market) cannot
// use the plugin at all (M2.2 finding).
import { api } from "./client";
import { scan as pluginScan, cancel as pluginCancel, checkPermissions, requestPermissions } from "@tauri-apps/plugin-barcode-scanner";

export type QrScanResult =
  | { ok: true; content: string }
  | { ok: false; reason: "denied" | "timeout" | "error"; message?: string };

const SCAN_TIMEOUT_MS = 30_000;

export class QrScannerAdapter {
  /**
   * Scan a QR code. Prefers the native bridge (no-GMS capable); falls back to
   * the barcode-scanner plugin. Never hangs: each path has a hard timeout and
   * the camera is torn down afterwards.
   */
  static async scan(): Promise<QrScanResult> {
    // 1) native path (CameraX + bundled ML Kit, no GMS required)
    try {
      const content = await api.qrScan(SCAN_TIMEOUT_MS);
      return { ok: true, content };
    } catch (e: any) {
      const msg: string = e?.message ?? e ?? "";
      // camera permission / busy / timeout / bridge error — all recoverable
      if (msg.includes("timeout")) {
        return { ok: false, reason: "timeout", message: msg };
      }
      if (/camera permission denied/i.test(msg)) {
        return { ok: false, reason: "denied", message: msg };
      }
      // make sure the camera is torn down before trying the plugin
      try {
        await api.qrCancel();
      } catch {
        // ignore
      }
      // native path failed for a device-level reason — fall through to plugin
      // (GMS devices) so the user still gets a scanner when possible.
    }

    // 2) plugin path (unbundled ML Kit — requires GMS)
    try {
      const perm = await checkPermissions();
      if (perm !== "granted") {
        const p = await requestPermissions();
        if (p !== "granted") return { ok: false, reason: "denied" };
      }
      const res = await Promise.race([
        pluginScan({ windowed: false, formats: ["QR_CODE"] as any }),
        new Promise<null>((resolve) => {
          setTimeout(async () => {
            await pluginCancel();
            resolve(null);
          }, SCAN_TIMEOUT_MS);
        }),
      ]);
      if (res?.content) return { ok: true, content: res.content };
      return { ok: false, reason: "timeout" };
    } catch (e: any) {
      return { ok: false, reason: "error", message: e?.message ?? String(e) };
    }
  }

  /** Cancel any in-flight scan (tears the camera down). */
  static async cancel(): Promise<void> {
    try {
      await api.qrCancel();
    } catch {
      // ignore — plugin cancel is best-effort
    }
    try {
      await pluginCancel();
    } catch {
      // ignore
    }
  }
}
