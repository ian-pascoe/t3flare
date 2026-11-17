// @effect-diagnostics globalFetch:off globalDate:off cryptoRandomUUID:off
// The Environment DO's in-app Updates (ADR-0037): the records in its storage, and GitHub Actions on the update target's
// repository with a token from the DO's own minter (`UPDATE_DISPATCH_GITHUB_PERMISSIONS`, plan D5), minted per request
// and dropped. Without an update target (every stage but prod, plan D14) nothing is dispatched.
import { UPDATE_DISPATCH_GITHUB_PERMISSIONS } from "@t3flare/github-app/permissions";

import type { GitHubTokens } from "../agents/github.ts";
import { actionsClient, updateRepoOf } from "./actions.ts";
import { updates, type Updates, type UpdateStore } from "./records.ts";

export const environmentUpdates = (input: { readonly target: string | undefined; readonly store: UpdateStore; readonly github: () => GitHubTokens }): Updates => {
  const repo = updateRepoOf(input.target);
  return updates({
    store: input.store,
    actions:
      repo === undefined
        ? undefined
        : actionsClient({
            repo,
            token: async () => (await input.github().mint({ owner: repo.owner.toLowerCase(), repositories: [repo.name], permissions: UPDATE_DISPATCH_GITHUB_PERMISSIONS })).token,
            fetch: (url, init) => fetch(url, init),
          }),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
  });
};
