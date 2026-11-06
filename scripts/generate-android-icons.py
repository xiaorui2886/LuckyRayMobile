"""Generate Android resources preserving the complete original blue-purple rim.

Optional maintainer tool: Python 3 and Pillow==12.3.0. Normal builds only verify
and copy tracked resources and do not require an editor or Pillow.
"""
from pathlib import Path
import argparse
import hashlib
import io
import json
import PIL
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "src-tauri/icons"
MASTER_SHA256 = "fed987e1689e8bdb15eaad881e18e0f5d38bda3bc83fc17c2a10a4b977fd0a0c"
ORIGINAL_SHA256 = "74924112feeb2451c738b8a21fb252d501c0e4b94ab4d75b16846cb0f5e666ae"
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
CONTENT_BOUNDS = (177, 128, 1098, 1054)
EDGE_RADIUS = 8
OPAQUE_MIN = 250
CONTROL_POINTS = ((181,513), (185,513), (203,513), (650,138), (1067,600), (650,1047))
RETIRED = [f"android/mipmap-anydpi-v{v}/{name}.xml" for v in (26,33)
           for name in ("ic_launcher", "ic_launcher_round")]
RETIRED += ["android/values/ic_launcher_background.xml"]
RETIRED += [f"android/mipmap-{d}/ic_launcher_{layer}.png" for d in DENSITIES
            for layer in ("foreground", "background")]


def png_bytes(image):
    result=io.BytesIO()
    image.save(result,format="PNG",optimize=False,compress_level=9)
    return result.getvalue()


def clean_edge_rgb(original):
    """Remove white-matted fringe RGB without changing any source alpha byte.

    All nearly opaque source artwork, including the authored blue/purple rim,
    remains byte-identical. This is not a mask erosion or background fill.
    """
    width,height=original.size
    raw=original.tobytes(); output=bytearray(raw)
    offsets=sorted((dx*dx+dy*dy,dy,dx) for dy in range(-EDGE_RADIUS,EDGE_RADIUS+1)
                   for dx in range(-EDGE_RADIUS,EDGE_RADIUS+1)
                   if 0<dx*dx+dy*dy<=EDGE_RADIUS*EDGE_RADIUS)
    for index in range(width*height):
        if not 0<raw[index*4+3]<OPAQUE_MIN: continue
        y,x=divmod(index,width)
        for _,dy,dx in offsets:
            nx,ny=x+dx,y+dy
            if not 0<=nx<width or not 0<=ny<height: continue
            source=(ny*width+nx)*4
            if raw[source+3]>=OPAQUE_MIN:
                output[index*4:index*4+3]=raw[source:source+3]
                break
    cleaned=Image.frombytes("RGBA",original.size,bytes(output))
    if cleaned.getchannel("A").tobytes()!=original.getchannel("A").tobytes():
        raise RuntimeError("Defringe changed source alpha")
    return cleaned


def full_artwork(cleaned):
    """Trim near-invisible exterior canvas only; do not resample the artwork.

    All source alpha>=8 content plus 2px exterior remains. Pad to a square using
    transparency so Android's bitmap gravity cannot distort the original rim.
    """
    support=cleaned.getchannel("A").point(lambda a:255 if a>=8 else 0).getbbox()
    if not support or (support[0]-2,support[1]-2,support[2]+2,support[3]+2)!=CONTENT_BOUNDS:
        raise RuntimeError("Original visible-content bounds changed")
    panel=cleaned.crop(CONTENT_BOUNDS)
    size=max(panel.size); offset=((size-panel.width)//2,(size-panel.height)//2)
    artwork=Image.new("RGBA",(size,size))
    artwork.paste(panel,offset)  # Copy RGBA; never flatten onto an opaque matte.
    for x,y in CONTROL_POINTS:
        point=(x-CONTENT_BOUNDS[0]+offset[0],y-CONTENT_BOUNDS[1]+offset[1])
        if artwork.getpixel(point)!=cleaned.getpixel((x,y)):
            raise RuntimeError("Authored perimeter was changed or omitted")
    return artwork,offset


def generate():
    if PIL.__version__!="12.3.0": raise RuntimeError("Use Pillow==12.3.0 for reproducible output")
    raw=(ICONS/"icon.png").read_bytes()
    original_raw=(ICONS/"luckyray-original.png").read_bytes()
    if hashlib.sha256(raw).hexdigest()!=MASTER_SHA256: raise RuntimeError("Desktop source hash differs")
    if hashlib.sha256(original_raw).hexdigest()!=ORIGINAL_SHA256: raise RuntimeError("Original source hash differs")
    original=Image.open(io.BytesIO(original_raw)).convert("RGBA")
    if original.size!=(1254,1254): raise RuntimeError("Unexpected original canvas")
    cleaned=clean_edge_rgb(original); artwork,offset=full_artwork(cleaned)
    outputs={"luckyray-android.png":png_bytes(cleaned),
             "android/drawable-nodpi/ic_launcher_artwork.png":png_bytes(artwork)}
    # Keep conventional density fallbacks and template compatibility. Supported
    # Android versions use the anydpi-v21 XML and full-resolution nodpi artwork.
    for density,size in DENSITIES.items():
        bitmap=cleaned.resize((size,size),Image.Resampling.LANCZOS)
        for name in ("ic_launcher","ic_launcher_round"):
            outputs[f"android/mipmap-{density}/{name}.png"]=png_bytes(bitmap)
    outputs["android/mipmap-anydpi-v21/ic_launcher.xml"]=(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<bitmap xmlns:android="http://schemas.android.com/apk/res/android"\n'
        '  android:src="@drawable/ic_launcher_artwork"\n'
        '  android:gravity="fill" android:filter="true" android:dither="true"/>\n').encode()
    entries={"icon.png":raw,"luckyray-original.png":original_raw,**outputs}
    manifest={
        "schemaVersion":1,
        "source":"Complete LuckyRay original artwork, including its authored blue-purple bevel",
        "sourceRevision":"8479bbf20cf01d608b2415e746d74fe12b4081e7",
        "sourceDirectory":"luckyray-app/src-tauri/icons",
        "regeneration":"python scripts/generate-android-icons.py with Pillow==12.3.0; builds verify and copy outputs",
        "androidGeometry":{
            "revision":8,"kind":"complete-artwork-bitmap","background":"source-transparency",
            "source":"luckyray-original.png","derivedSource":"luckyray-android.png",
            "sourceCanvas":[1254,1254],"legacySizes":DENSITIES,
            "resourceMinApi":21,"contentBounds":list(CONTENT_BOUNDS),
            "artworkSize":list(artwork.size),"transparentPad":list(offset),
            "artworkResampled":False,"completePerimeter":True,"adaptiveWrapper":False,
            "perimeterControlPoints":[list(p) for p in CONTROL_POINTS],
            "defringe":{"method":"nearest-opaque-edge-rgb","radiusPx":8,"opaqueAlphaMin":250,"alphaUnchanged":True}},
        "files":[{"path":name,"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest()}
                 for name,data in sorted(entries.items())]}
    outputs["luckyray-branding.json"]=(json.dumps(manifest,indent=2)+"\n").encode()
    return outputs


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check",action="store_true");args=parser.parse_args()
    outputs=generate()
    for name in RETIRED:
        path=ICONS/name
        if path.exists():
            if args.check: raise RuntimeError(f"Retired adaptive layer remains: {name}")
            if not path.resolve().is_relative_to(ICONS.resolve()): raise RuntimeError("Unsafe icon path")
            path.unlink()
    for name,data in outputs.items():
        path=ICONS/name
        if args.check:
            if not path.is_file() or path.read_bytes()!=data: raise RuntimeError(f"Regeneration differs: {name}")
        else:
            path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    print(json.dumps({"result":"PASS","mode":"check" if args.check else "generate",
                      "sourceOriginalUnchanged":True,"completePerimeter":True,
                      "perimeterControlPoints":len(CONTROL_POINTS),"artworkResampled":False,
                      "phoneSpecificBranches":0,"adaptiveWrappers":0,"resourceFiles":12}))
