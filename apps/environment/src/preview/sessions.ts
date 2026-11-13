// @effect-diagnostics asyncFunction:off globalConsole:off
// The Browser Run sessions a new Environment DO instance inherits (G11, review M5): its predecessor's CDP sockets died
// with it, so its browsers can only cost money until Browser Run's keep-alive ends them. They are closed at once.
import type { BrowserRunBinding } from "./browserRun.ts";
import type { PreviewStore } from "./store.ts";

/** Closes every session the store lists, as it lists them now (read before any new one is added). */
export const closeLeftoverSessions = (binding: Pick<BrowserRunBinding, "closeSession">, store: PreviewStore): Promise<number> => {
  const leftover = store.sessions();
  return Promise.all(
    leftover.map(async (session) => {
      await binding.closeSession(session.id).catch(() => undefined);
      store.sessionClosed(session.id);
    }),
  ).then(() => {
    if (leftover.length > 0) console.log(JSON.stringify({ t3flare: "preview-sessions-closed-at-boot", count: leftover.length }));
    return leftover.length;
  });
};
