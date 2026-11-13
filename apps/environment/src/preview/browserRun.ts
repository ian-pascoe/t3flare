// The Browser Run binding (formerly Browser Rendering) as this Worker uses it (parity G11, ADR-0031): the Workers
// runtime's own type, re-exported so the rest of the package names one thing.
import type { BrowserRun, Fetcher } from "@cloudflare/workers-types/index.ts";

export type BrowserRunBinding = BrowserRun;
export type BrowserRunFetcher = Fetcher;

/** The Container preview hosts (`http://<port>.t3flare.internal/`): Browser Run routes at most eight, HTTP on port 80. */
export const CONTAINER_PREVIEW_PORTS: ReadonlyArray<number> = [3000, 3001, 4173, 4321, 5173, 5174, 8000, 8787];

export const CONTAINER_PREVIEW_DOMAIN = "t3flare.internal";

export const containerPreviewHost = (port: number): string => `${port}.${CONTAINER_PREVIEW_DOMAIN}`;

const CONTAINER_PREVIEW_HOST = /^(\d{1,5})\.t3flare\.internal$/;

/** The Container port a Container preview's URL is for; undefined for any other host or an explicit port. */
export const containerPreviewPortOf = (url: URL): number | undefined => {
  const port = Number(CONTAINER_PREVIEW_HOST.exec(url.hostname)?.[1]);
  return CONTAINER_PREVIEW_PORTS.includes(port) && url.port === "" && url.protocol === "http:" ? port : undefined;
};

/** Browser Run's keep-alive for every browser t3flare acquires: the most the binding allows (10 minutes). */
export const BROWSER_KEEP_ALIVE_MS = 600_000;
