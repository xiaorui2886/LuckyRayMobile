// Live-vs-cache provenance returned by the Mobile content layer.
// The Rust side stamps `source` where the answer came from; the UI must never
// infer it from Promise status.
export type Provenance = "live" | "cache";

export function provenanceOf(value: unknown): Provenance {
  return (value as any)?.source === "cache" ? "cache" : "live";
}
