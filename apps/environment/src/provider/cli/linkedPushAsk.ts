// SPI-1040: a push from a CLI thread's Workspace, asked of the owner on that thread (the push gateway's policy, through
// the Environment DO's `approvePush`). Until the CLI wrapper can raise the card, every such push is refused, as before
// SPI-992 for linked CLI work (step 4a F8).

export const approveCliPush = (input: { readonly thread: string; readonly linked: boolean }): Promise<{ readonly approved: boolean; readonly trust?: boolean; readonly reason?: string }> =>
  Promise.resolve({ approved: false, reason: `pushes from CLI threads cannot be asked yet (thread ${input.thread})` });

/** Withdraws the card of a push whose git went away (review M7). */
export const cancelCliPush = (_askId: string): void => undefined;
