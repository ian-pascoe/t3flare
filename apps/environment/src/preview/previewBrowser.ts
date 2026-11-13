// t3's `PreviewBrowser` (G11's M1, ADR-0031) as a Layer: Chrome is never downloaded. Its executable is the CDP bridge
// to Browser Run our process router answers (`htmlBrowser.ts`); without a Browser Run binding (local workerd, tests)
// there is none, as on a host where t3 cannot install one.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PreviewBrowser from "t3/src/preview/PreviewBrowser.ts";

import { environmentServices } from "../agents/bindings.ts";
import { HTML_BROWSER_EXECUTABLE } from "./htmlBrowser.ts";

const bound = () => environmentServices().browserRun !== undefined;

export const layer = Layer.succeed(
  PreviewBrowser.PreviewBrowser,
  PreviewBrowser.PreviewBrowser.of({
    executable: Effect.suspend(() =>
      bound()
        ? Effect.succeed(HTML_BROWSER_EXECUTABLE)
        : Effect.fail(new PreviewBrowser.PreviewBrowserUnsupportedError({ platform: "workerd", arch: "none" })),
    ),
    installed: Effect.sync(() => (bound() ? Option.some(HTML_BROWSER_EXECUTABLE) : Option.none())),
  }),
);
