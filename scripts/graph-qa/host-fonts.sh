#!/usr/bin/env bash
# Source from host browser driver. Scoped user-readable fonts; no system install/permission changes.
[[ "${GITHUB_ACTIONS:-}" == true && "${CI_GRAPH_QA_REVIEWED:-}" == yes ]] || return 2
: "${RUNNER_TEMP:?}" "${GRAPH_QA_EVIDENCE:?}"
command -v fc-list >/dev/null && command -v fc-match >/dev/null || { echo 'fontconfig unavailable' >&2; return 3; }
if [[ -z "$(fc-list :lang=zh-cn file)" ]]; then
  command -v apt-get >/dev/null && command -v dpkg-deb >/dev/null || { echo 'No CJK fonts or official Ubuntu package tools available' >&2; return 3; }
  font_root="$RUNNER_TEMP/graph-font-root"
  mkdir -p "$font_root/packages" "$font_root/cache"
  # Ubuntu's configured signed package index selects the official package and verifies download hashes.
  apt-cache policy fonts-noto-cjk > "$GRAPH_QA_EVIDENCE/font-package-policy.txt"
  cat "$GRAPH_QA_EVIDENCE/font-package-policy.txt"
  (cd "$font_root/packages" && apt-get download fonts-noto-cjk)
  python3 - "$font_root" <<'PY_FONT'
import pathlib,subprocess,sys,hashlib
root=pathlib.Path(sys.argv[1]);packages=list((root/'packages').glob('fonts-noto-cjk_*.deb'))
if len(packages)!=1: raise SystemExit('Exactly one official Noto CJK package required')
p=packages[0];subprocess.run(['dpkg-deb','-x',str(p),str(root/'unpacked')],check=True)
(root/'package-sha256.txt').write_text(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n')
PY_FONT
  export FONTCONFIG_FILE="$font_root/fonts.conf"
  python3 - "$font_root" <<'PY_CONFIG'
import pathlib,sys,xml.sax.saxutils
root=pathlib.Path(sys.argv[1]);escape=xml.sax.saxutils.escape
(root/'fonts.conf').write_text('<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include><dir>'+escape(str(root/'unpacked/usr/share/fonts'))+'</dir><cachedir>'+escape(str(root/'cache'))+'</cachedir></fontconfig>')
PY_CONFIG
  cp "$font_root/package-sha256.txt" "$GRAPH_QA_EVIDENCE/font-package-sha256.txt"
fi
[[ -n "$(fc-list :lang=zh-cn file)" ]] || { echo 'Chinese font coverage absent; visual QA blocked' >&2; return 3; }
{
  echo 'Chinese glyph coverage from fc-list :lang=zh-cn:'
  fc-list :lang=zh-cn family | sed -n '1,12p'
  printf 'Matched CJK font: '; fc-match 'sans-serif:lang=zh-cn' -f '%{family}: %{file}\n'
} > "$GRAPH_QA_EVIDENCE/cjk-font-evidence.txt"
cat "$GRAPH_QA_EVIDENCE/cjk-font-evidence.txt"
