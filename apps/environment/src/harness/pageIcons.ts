// The harness panel's icons (SPI-1086): one inline SVG sprite of simple 24-unit stroke shapes drawn here, referenced with
// `<use href="#i-…">` (same document, so the CSP's `img-src 'none'` and `default-src 'none'` do not apply). No icon font
// or library, nothing fetched.
const SYMBOLS: Record<string, string> = {
  logo: '<path d="M12 3.5L3.5 8 12 12.5 20.5 8z"/><path d="M3.5 12L12 16.5 20.5 12M3.5 16L12 20.5 20.5 16"/>',
  extensions: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><path d="M16.5 13v7M13 16.5h7"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  container: '<path d="M12 3.5l8 4.5v8L12 20.5 4 16V8z"/><path d="M4 8l8 4.5L20 8M12 12.5v8"/>',
  skills: '<path d="M12 3.5l2.2 5.3 5.3 2.2-5.3 2.2L12 18.5l-2.2-5.3L4.5 11l5.3-2.2z"/>',
  status: '<path d="M3.5 12h4l2.5-6 4 12 2.5-6h4"/>',
  audit: '<path d="M7 3.5h10a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5M12 16h.01"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  login: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 8l4 4-4 4M14 12H4"/>',
  trash: '<path d="M4.5 7h15M10 11v6M14 11v6"/><path d="M6.5 7l1 12.5h9l1-12.5M9.5 7V4.5h5V7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="M9.5 6l6 6-6 6"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8.5-8.5M16 7l2.5 2.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
};

export type IconName = keyof typeof SYMBOLS;

/** The sprite, once per page. */
export const ICON_SPRITE = `<svg xmlns="http://www.w3.org/2000/svg" hidden aria-hidden="true">${Object.entries(SYMBOLS)
  .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`)
  .join("")}</svg>`;

/** A decorative icon: its meaning is always in the text beside it. */
export const icon = (name: IconName): string => `<svg class="i" aria-hidden="true" focusable="false"><use href="#i-${name}"/></svg>`;
