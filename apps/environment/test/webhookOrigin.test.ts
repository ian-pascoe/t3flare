// Parity G12: a task webhook's URL is on the public t3 host, at t3's own hook route.
import { describe, expect, it } from "vitest";

import { WEBHOOK_ROUTE_PREFIX } from "t3/src/scheduledTasks/ScheduledTaskService.ts";
import { webhookBaseUrl } from "../src/t3/webhookOrigin.ts";

describe("the task webhooks' base URL", () => {
  it("is t3's hook route on the public host, so t3's `<base>/<task>/<token>` is a URL the host serves", () => {
    expect(WEBHOOK_ROUTE_PREFIX).toBe("/api/hooks");
    expect(webhookBaseUrl("https://t3.example.com")).toBe("https://t3.example.com/api/hooks");
    expect(webhookBaseUrl("https://t3.example.com/")).toBe("https://t3.example.com/api/hooks");
  });

  it("is null without a configured host, as stock t3 without a relay", () => {
    expect(webhookBaseUrl(null)).toBeNull();
  });
});
