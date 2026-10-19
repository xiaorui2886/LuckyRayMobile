import { useEffect, useState } from "react";
import { api } from "../services/client";

export default function CachedMedia({instance, id, vault, note, version, mime, poster}: {instance: string; id: string; vault?: string; note?: string; version: string; mime: string; poster?: string}) {
  const [url,setUrl]=useState("");
  const [error,setError]=useState(false);
  useEffect(() => {
    let alive=true; let token="";
    setUrl(""); setError(false);
    void api.contentMediaSource(instance,id,vault,note).then(value => {
      if (!alive) { void api.contentMediaRelease(value.token); return; }
      token=value.token; setUrl(value.url);
    }).catch(() => { if (alive) setError(true); });
    return () => { alive=false; if (token) void api.contentMediaRelease(token); };
  },[instance,id,vault,note,version]);
  return <span style={{display:"block"}}>
    {url && (mime.startsWith("video/") ? <video src={url} poster={poster} controls playsInline onError={() => setError(true)} style={{width:"100%",maxHeight:"60vh"}} /> : <audio src={url} controls onError={() => setError(true)} />)}
    {error && <span role="status">此音视频暂时无法播放，请检查文件格式后重试。</span>}
  </span>;
}
