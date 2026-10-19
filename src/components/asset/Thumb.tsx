import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../../services/client";

/**
 * Lazy thumbnail: placeholder -> local cache / gateway -> asset-protocol URI.
 *
 * `instance` is the Desktop the row belongs to. A thumbnail belongs to ONE
 * Desktop, so it is requested against that owner — the authority refuses rather
 * than serving a different Desktop's cached image. When the row has no provable
 * owner the thumbnail is not requested at all (the placeholder stays).
 */
export default function Thumb({ instance, id }: { instance: string; id: string }) {
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setSrc("");
    setFailed(false);
    if (!instance) return () => { alive = false; };
    api
      .assetThumbnail(instance, id)
      .then((t) => {
        if (alive && t?.uri) setSrc(convertFileSrc(t.uri));
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [instance, id]);

  if (failed) return null;
  if (!src) return null; // gradient placeholder stays visible underneath
  return <img src={src} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />;
}
