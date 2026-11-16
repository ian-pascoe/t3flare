// @effect-diagnostics globalConsole:off globalTimers:off
// A sign-out stops the signed-out endpoint's Sessions (SPI-1164): every open Pi Durable session is told, drops any
// token it holds for the endpoint, and stops its live turns when they run on it. Which endpoint a Session's turns run on
// is the Session's own record, kept in its storage (agents' `session/signOut.ts`), so it holds after a Session restarts.
//
// Which sessions are open is the push registry (`registeredSessions`), which is in memory: after an Environment restart
// it holds only the sessions t3 has opened again since. A Session it misses is bounded all the same: the restart ended
// its running turns (ADR-0004; a turn still running is aborted as an orphan at its next push), the token it may hold in
// memory lives at most 5 minutes (`ENDPOINT_KEY_TTL_MS`), and the broker gives it no other (the tokens are gone, and
// the refresh token is revoked). Deriving the set from t3's durable provider sessions would buy no more than that.

/** How long a sign-out waits for each Session's answer: a Session that hangs does not hold up the revocation. */
export const SESSION_ANSWER_MS = 5_000;

/** What a sign-out asks of a Session (the agents Worker's `SessionDO`). */
export interface SignedOutSession {
  endpointSignedOut(input: { readonly endpointId: string }): Promise<{ readonly dropped: boolean; readonly stopped: boolean }>;
}

/**
 * Tells every open session that `endpointId` was signed out, each bounded to `timeoutMs`. Best effort: a Session that
 * fails or does not answer in time is logged and skipped. Never rejects.
 */
export const stopSessionsOn = async (
  endpointId: string,
  sessions: { readonly open: () => ReadonlyArray<string>; readonly session: (name: string) => SignedOutSession; readonly timeoutMs?: number },
): Promise<{ readonly told: number; readonly stopped: number }> => {
  const timeoutMs = sessions.timeoutMs ?? SESSION_ANSWER_MS;
  const tell = async (name: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        sessions.session(name).endpointSignedOut({ endpointId }),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs))),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const names = [...sessions.open()];
  const answers = await Promise.allSettled(names.map(tell));
  let told = 0;
  let stopped = 0;
  answers.forEach((answer, index) => {
    if (answer.status === "fulfilled") {
      told += 1;
      if (answer.value.stopped) stopped += 1;
    } else {
      console.warn(JSON.stringify({ t3flare: "sign-out-session-failed", endpoint: endpointId, session: names[index], error: String(answer.reason).slice(0, 200) }));
    }
  });
  console.log(JSON.stringify({ t3flare: "sign-out-sessions", endpoint: endpointId, told, stopped }));
  return { told, stopped };
};
