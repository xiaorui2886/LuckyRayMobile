// Icon system (STITCH-R6) — the R6 prototype's SVG markup, migrated 1:1.
//
// Source of truth: LuckyRay-Mobile-Visual-Rebuild-R6.html (SHA256 db603422…a538),
// `const I = { ... }`. Stroke width 1.8, 24×24 viewBox, no fills except the
// play/more glyphs, no emoji. Optical size is chosen by the CALLER via `size`
// (DESIGN.md §8), never by container size.
//
// Legacy names used by existing screens are kept as aliases so the migration
// does not require a big-bang rename.

import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function stroke({ size = 18, ...rest }: P) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    "aria-hidden": true,
    ...rest,
  } as SVGProps<SVGSVGElement>;
}

function solid({ size = 18, ...rest }: P) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "currentColor",
    "aria-hidden": true,
    ...rest,
  } as SVGProps<SVGSVGElement>;
}

/* ---- Bottom navigation + roots ---- */
export const IconHome = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M3.5 10.5 12 3.8l8.5 6.7v9.7H14.7v-6.1H9.3v6.1H3.5z" />
  </svg>
);
export const IconLibrary = (p: P) => (
  <svg {...stroke(p)}>
    <rect x="3.5" y="4" width="17" height="16" rx="2" />
    <path d="M7 8h10M7 12h10M7 16h6" />
  </svg>
);
export const IconAi = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M12 3.2c1.3 3 3.2 4.9 6.2 6.2-3 1.3-4.9 3.2-6.2 6.2-1.3-3-3.2-4.9-6.2-6.2 3-1.3 4.9-3.2 6.2-6.2Z" />
    <path d="M18.2 15.1c.5 1.2 1.3 2 2.5 2.5-1.2.5-2 1.3-2.5 2.5-.5-1.2-1.3-2-2.5-2.5 1.2-.5 2-1.3 2.5-2.5Z" />
  </svg>
);
export const IconNotes = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M4 5.2c3.5-.8 6.2-.1 8 1.5v13c-1.8-1.6-4.5-2.3-8-1.5zM20 5.2c-3.5-.8-6.2-.1-8 1.5v13c1.8-1.6 4.5-2.3 8-1.5z" />
  </svg>
);
export const IconUser = (p: P) => (
  <svg {...stroke(p)}>
    <circle cx="12" cy="8" r="3.4" />
    <path d="M5.5 20c.5-4 3-6 6.5-6s6 2 6.5 6" />
  </svg>
);

/* ---- Actions ---- */
export const IconPlus = (p: P) => (
  <svg {...stroke({ ...p, strokeWidth: 2 })}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const IconSearch = (p: P) => (
  <svg {...stroke(p)}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="m15 15 5 5" />
  </svg>
);
export const IconFilter = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M4 6h16M7 12h10M10 18h4" />
  </svg>
);
export const IconBack = (p: P) => (
  <svg {...stroke(p)}>
    <path d="m14.5 5-7 7 7 7" />
  </svg>
);
export const IconChevronRight = (p: P) => (
  <svg {...stroke({ size: 14, ...p })}>
    <path d="m9 5 7 7-7 7" />
  </svg>
);
/** Home masthead settings/controls action (DESIGN.md §8: must read as
 *  settings, never a profile icon and never a sun/theme icon). */
export const IconControls = (p: P) => (
  <svg {...stroke({ ...p, strokeWidth: 1.85 })}>
    <line x1="5" y1="7" x2="19" y2="7" />
    <circle cx="9" cy="7" r="2.1" />
    <line x1="5" y1="17" x2="19" y2="17" />
    <circle cx="15" cy="17" r="2.1" />
  </svg>
);

/* ---- Content kinds ---- */
export const IconImage = (p: P) => (
  <svg {...stroke(p)}>
    <rect x="3.5" y="4" width="17" height="16" rx="2" />
    <circle cx="9" cy="9" r="1.5" />
    <path d="m5.5 17 4.5-4.5 3 3 2-2 3.5 3.5" />
  </svg>
);
export const IconText = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M5 6h14M8 10h8M8 14h8M5 18h14" />
  </svg>
);
export const IconLink = (p: P) => (
  <svg {...stroke(p)}>
    <path d="m10 14 4-4M8.2 16.6l-1.1 1.1a3.4 3.4 0 0 1-4.8-4.8l3.4-3.4a3.4 3.4 0 0 1 4.8 0M15.8 7.4l1.1-1.1a3.4 3.4 0 0 1 4.8 4.8l-3.4 3.4a3.4 3.4 0 0 1-4.8 0" />
  </svg>
);
export const IconCamera = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M4 8h3l1.3-2h7.4L17 8h3v11H4z" />
    <circle cx="12" cy="13" r="3.2" />
  </svg>
);
export const IconFile = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M6 3.5h8l4 4V20H6z" />
    <path d="M14 3.5V8h4" />
  </svg>
);
export const IconDesktop = (p: P) => (
  <svg {...stroke(p)}>
    <rect x="3.5" y="4.5" width="17" height="12" rx="2" />
    <path d="M8 20h8M12 16.5V20" />
  </svg>
);
export const IconVideo = (p: P) => (
  <svg {...stroke(p)}>
    <rect x="3.5" y="4" width="17" height="16" rx="2" />
    <path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none" />
  </svg>
);
export const IconPlay = (p: P) => (
  <svg {...solid(p)}>
    <path d="M9 7.2 17 12l-8 4.8z" />
  </svg>
);
export const IconMore = (p: P) => (
  <svg {...solid(p)}>
    <circle cx="5" cy="12" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="19" cy="12" r="1.4" />
  </svg>
);
export const IconRefresh = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 4v4h-4" />
  </svg>
);
export const IconStop = (p: P) => (
  <svg {...stroke(p)}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" />
  </svg>
);
export const IconClose = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M7 7l10 10M17 7L7 17" />
  </svg>
);
export const IconCheck = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M6 12.5l4 4L18 8" />
  </svg>
);
export const IconChevronDown = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M6 10l6 6 6-6" />
  </svg>
);

/* ---- Production action glyphs ----
 * The R6 prototype only needed the glyphs its demo screens showed. Production
 * has additional REAL actions (favorite, archive, delete, pin, tag, attach,
 * checklist, send, refresh) that need their own distinct marks drawn in the
 * same language: 24×24 viewBox, 1.8 stroke, round caps/joins. Aliasing these to
 * an unrelated glyph would put a sparkle where a star belongs. */
export const IconFavorite = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M12 4.2l2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4-3.9 5.6-.8z" />
  </svg>
);
export const IconArchive = (p: P) => (
  <svg {...stroke(p)}>
    <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.2" />
    <path d="M5.5 9v9.5a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9" />
    <path d="M10 13h4" />
  </svg>
);
export const IconDelete = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M4.5 6.5h15" />
    <path d="M9.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5" />
    <path d="M6.5 6.5 7.6 19a1 1 0 0 0 1 .9h6.8a1 1 0 0 0 1-.9l1.1-12.5" />
    <path d="M10.5 10v6M13.5 10v6" />
  </svg>
);
export const IconPin = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M9 3.5h6l-.6 5 2.6 3H7l2.6-3z" />
    <path d="M12 11.5V20" />
  </svg>
);
export const IconTag = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M4 11.4V6.2A2.2 2.2 0 0 1 6.2 4h5.2l8.4 8.4-7.4 7.4z" />
    <circle cx="8.6" cy="8.6" r="1.3" />
  </svg>
);
export const IconAttach = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M8.6 12.6l5.6-5.6a3.1 3.1 0 1 1 4.4 4.4l-7.7 7.7a4.5 4.5 0 0 1-6.4-6.4l7-7" />
  </svg>
);
export const IconChecklist = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M9.5 7h9M9.5 12h9M9.5 17h9" />
    <path d="m4 6.6 1.4 1.4L8 5.4M4 11.6l1.4 1.4L8 10.4M4 16.6l1.4 1.4L8 15.4" />
  </svg>
);
export const IconSend = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M12 19.5V4.5" />
    <path d="M6.5 10 12 4.5 17.5 10" />
  </svg>
);
export const IconGrid = (p: P) => (
  <svg {...stroke(p)}>
    <rect x="4" y="4" width="7" height="7" rx="1.4" />
    <rect x="13" y="4" width="7" height="7" rx="1.4" />
    <rect x="4" y="13" width="7" height="7" rx="1.4" />
    <rect x="13" y="13" width="7" height="7" rx="1.4" />
  </svg>
);
export const IconList = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M4.5 7h15M4.5 12h15M4.5 17h15" />
  </svg>
);
export const IconSort = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M7 5v14M7 19l-2.6-2.6M7 19l2.6-2.6" />
    <path d="M13 7h7M13 12h5M13 17h3" />
  </svg>
);
export const IconInbox = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M3.5 12.5 6 5.5h12l2.5 7v5.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z" />
    <path d="M3.5 12.5H8a4 4 0 0 0 8 0h4.5" />
  </svg>
);
export const IconPlug = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M9 3.5v4M15 3.5v4" />
    <path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-5.5 5.5 5.5 5.5 0 0 1-5.5-5.5z" />
    <path d="M12 16v4.5" />
  </svg>
);
export const IconMenu = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M4 7h16M4 12h16M4 17h10" />
  </svg>
);
export const IconSparkles = (p: P) => IconAi(p);
export const IconCapture = (p: P) => (
  <svg {...stroke(p)}>
    <path d="M12 5v14M5 12h14" />
    <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
  </svg>
);
