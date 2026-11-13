// Adapted from cloudpid@93ba45a3:packages/extensions/src/web.ts (SPI-1054; parity row pi-web-tools): the `web`
// extension, `web_fetch` (the Worker's own `fetch`, through the SSRF guard) and, when the harness setting turns it on,
// `web_search` (a search-capable model through the model proxy; `web/search.ts` says why). Both are reads: no mode asks
// for them, and linked threads may use them. In code mode they are the `web` namespace.
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";

import { webFetchTool } from "./web/fetch.ts";
import { type WebTransport, workerTransport } from "./web/net.ts";
import { type SearchProxy, webSearchTool } from "./web/search.ts";

export const WEB_EXTENSION = "web";

/** The web tools in a code mode script (`tools.web_fetch`, `tools.web_search`). */
export const WEB_NAMESPACE: CodemodeNamespace = { name: "web", description: "The public web: fetch a page, search", prefix: "web_" };

export interface WebOptions {
  /** `web_search`'s proxy; absent: `web_search` is not offered. */
  readonly search?: SearchProxy;
  readonly transport?: WebTransport;
}

export const webExtension = (options: WebOptions = {}): Extension => {
  const transport = options.transport ?? workerTransport;
  return defineExtension({
    name: WEB_EXTENSION,
    tools: [webFetchTool(transport), ...(options.search === undefined ? [] : [webSearchTool(transport, options.search)])],
  });
};
