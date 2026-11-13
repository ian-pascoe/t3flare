// Parity G12: where t3's task webhooks are reached. Stock t3 hands out its relay's URL (`<relay>/v1/hooks/<endpoint
// key>/<task>/<token>`, `relayHookBaseUrl`), which forwards to the server's own route; the Cloud Environment's t3 host is
// public (ADR-0010) and serves that route itself, so the base is the host's route prefix.
import { WEBHOOK_ROUTE_PREFIX } from "t3/src/scheduledTasks/ScheduledTaskService.ts";

/** The base t3 appends `/<task id>/<token>` to, or null without a public origin (no hook URL, as stock t3 without a relay). */
export const webhookBaseUrl = (origin: string | null): string | null => (origin === null ? null : `${origin.replace(/\/+$/, "")}${WEBHOOK_ROUTE_PREFIX}`);
