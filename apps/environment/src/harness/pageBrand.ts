// t3flare's brand on the panel and the Change page: the flare mark and the wordmark, drawn here as constants (the
// shapes and colours of tools/demo-video's Spark and Wordmark, which render docs/assets/). Inline, so the CSP's
// `default-src 'none'` fetches nothing; the favicon is a `data:` URL, the one source `img-src` allows.

const FLARE_FROM = "#FF7A1A";
const FLARE_TO = "#FFB547";

/** The four-point flare: each side a quadratic curve bent to the centre, wider than tall. */
const FLARE_PATH = "M0,-10 Q0,0 18,0 Q0,0 0,10 Q0,0 -18,0 Q0,0 0,-10 Z";

const flareSvg = (gradientId: string, attributes: string) =>
  `<svg ${attributes}><defs><linearGradient id="${gradientId}" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="${FLARE_FROM}"/><stop offset="1" stop-color="${FLARE_TO}"/></linearGradient></defs><path d="${FLARE_PATH}" fill="url(#${gradientId})"/></svg>`;

/** The mark in its tile, as the GitHub App's icon: the flare on black. Once per page (its gradient's id). */
export const BRAND_MARK = `<span class="brand-mark">${flareSvg("flare-gradient", 'class="flare" viewBox="-18 -18 36 36" aria-hidden="true" focusable="false"')}</span>`;

/** "t3flare": "t3" in the text colour, "flare" in the flare's gradient. */
export const WORDMARK = '<span class="wordmark">t3<span class="wordmark-flare">flare</span></span>';

/** The browser tab's icon: the flare alone, square. */
export const FAVICON = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(
  flareSvg("f", 'xmlns="http://www.w3.org/2000/svg" viewBox="-18 -18 36 36"'),
)}">`;
