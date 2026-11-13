// OTLP export from the Cloud Environment (parity batch 2), as stock t3 does it: the OTLP endpoints the owner saves in
// t3's settings (Settings → Advanced → Observability: `observability.otlpTracesUrl`, `otlpMetricsUrl`, `otlpLogsUrl`)
// are read from the State directory's `settings.json` when t3 starts (`cli/config.ts` `loadPersistedObservabilitySettings`
// on a laptop; here at each boot of the Environment, so a change applies after its next restart, as on a laptop). t3's
// own `Observability.layer` then exports from the Environment DO with `fetch`, every `exportIntervalMs` (10 s) while t3
// runs and once as it shuts down: a few subrequests a minute against the 10,000 per invocation Workers allow.
// The Worker has no environment variables for it (no `T3CODE_OTLP_*`, no `OTEL_*`): the settings are the only source.
import type { ServerConfig } from "t3/src/config.ts";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";

type OtlpFields = Pick<
  ServerConfig["Service"],
  | "otlpTracesUrl"
  | "otlpMetricsUrl"
  | "otlpLogsUrl"
  | "otlpTracesExport"
  | "otlpMetricsExport"
  | "otlpLogsExport"
  | "otlpTracesSource"
  | "otlpMetricsSource"
  | "otlpLogsSource"
>;

/** `ServerConfig`'s OTLP fields from the text of t3's `settings.json` (undefined or unreadable: no export). */
export const otlpConfigFromSettings = (raw: string | undefined): OtlpFields => {
  const saved = parsePersistedServerObservabilitySettings(raw ?? "");
  const resolve = (signal: "traces" | "metrics" | "logs", settingsUrl: string | undefined) =>
    OtelEnvironment.resolveSignalEndpoint(OtelEnvironment.none, signal, { url: undefined, export: DEFAULT_SIGNAL_EXPORT }, { bootstrapUrl: undefined, settingsUrl });
  const traces = resolve("traces", saved.otlpTracesUrl);
  const metrics = resolve("metrics", saved.otlpMetricsUrl);
  const logs = resolve("logs", saved.otlpLogsUrl);
  return {
    otlpTracesUrl: traces?.url,
    otlpMetricsUrl: metrics?.url,
    otlpLogsUrl: logs?.url,
    otlpTracesExport: traces?.export ?? DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: metrics?.export ?? DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: logs?.export ?? DEFAULT_SIGNAL_EXPORT,
    ...(traces === undefined ? {} : { otlpTracesSource: traces.source }),
    ...(metrics === undefined ? {} : { otlpMetricsSource: metrics.source }),
    ...(logs === undefined ? {} : { otlpLogsSource: logs.source }),
  };
};
