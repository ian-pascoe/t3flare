// Types t3's own code needs in this program and not in t3's (fragility U10). t3's server is checked without the DOM
// lib, where playwright's `HTMLElement` does not resolve and its page functions take any element; this program has the
// DOM lib (and Workers types), so they are real. Types only: nothing here runs, and t3's source stays as pinned.
import "playwright-core";

/**
 * A page element as t3's structural page-function types read it: the DOM's, with the root's and shadow root's
 * `activeElement` loose (DOM's `getRootNode()` returns a `Node`, which has none) and `contains` taking any node.
 */
type T3PageElement = (HTMLElement | SVGElement) & {
  readonly shadowRoot: { readonly activeElement: any } | null;
  getRootNode(): { readonly activeElement?: any };
  contains(other: any): boolean;
};

declare module "playwright-core" {
  interface Locator {
    // t3 `apps/server/src/preview/ServerBrowserPage.ts` `type`: `focusTextTarget` takes its own `FocusCandidate`
    // (since v0.1.11-nightly.20261117.4825).
    evaluate<R, Arg>(
      pageFunction: (element: T3PageElement, arg: Arg) => R | Promise<R>,
      arg?: Arg,
      options?: { timeout?: number },
    ): Promise<R>;
  }
}
