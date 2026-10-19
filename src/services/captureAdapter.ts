// MobileCaptureAdapter — platform-agnostic capture interface.
// Android: implemented via capture_pick (CaptureBridge Kotlin -> private outbox).
// iOS: same interface, implementation deferred (no fake implementation).

import { invoke } from "@tauri-apps/api/core";

export interface CaptureMediaResult {
  refId: string;
  kind: "image" | "file";
  fileName: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  localUri: string;
}

export interface MobileCaptureAdapter {
  pickImage(): Promise<CaptureMediaResult | null>;
  takePhoto(): Promise<CaptureMediaResult | null>;
  pickFile(): Promise<CaptureMediaResult | null>;
}

class TauriCaptureAdapter implements MobileCaptureAdapter {
  private async pick(kind: string): Promise<CaptureMediaResult | null> {
    try {
      const op = await invoke<any>("capture_pick", { kind });
      const att = op?.attachmentRefs?.[0];
      if (!att) return null;
      return {
        refId: att.refId,
        kind: att.kind,
        fileName: att.fileName,
        mime: att.mime ?? "",
        sizeBytes: att.sizeBytes ?? 0,
        sha256: att.sha256 ?? "",
        localUri: "",
      };
    } catch (e: any) {
      // cancelled / error surfaces to the UI layer
      throw e;
    }
  }
  pickImage() {
    return this.pick("image");
  }
  takePhoto() {
    return this.pick("photo");
  }
  pickFile() {
    return this.pick("file");
  }
}

export const captureAdapter: MobileCaptureAdapter = new TauriCaptureAdapter();
