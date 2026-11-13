// Parity batch 2: OTLP endpoints come from the owner's saved t3 settings, as stock t3 reads them at start.
import { describe, expect, it } from "vitest";

import { otlpConfigFromSettings } from "../src/t3/otlp.ts";

describe("the Environment's OTLP endpoints", () => {
  it("are the traces and metrics URLs saved in t3's settings, marked as from the settings", () => {
    const config = otlpConfigFromSettings(
      JSON.stringify({ observability: { otlpTracesUrl: "https://otel.example/v1/traces", otlpMetricsUrl: "https://otel.example/v1/metrics" } }),
    );
    expect(config).toMatchObject({
      otlpTracesUrl: "https://otel.example/v1/traces",
      otlpMetricsUrl: "https://otel.example/v1/metrics",
      otlpLogsUrl: undefined,
      otlpTracesSource: "settings",
      otlpMetricsSource: "settings",
      otlpTracesExport: { protocol: "http/json", exportIntervalMs: 10_000 },
    });
  });

  it("are unset with no settings file, an unreadable one, or blank URLs", () => {
    for (const raw of [undefined, "not json", JSON.stringify({ observability: { otlpTracesUrl: "  " } })]) {
      const config = otlpConfigFromSettings(raw);
      expect(config.otlpTracesUrl).toBeUndefined();
      expect(config.otlpMetricsUrl).toBeUndefined();
      expect(config.otlpTracesSource).toBeUndefined();
    }
  });
});
