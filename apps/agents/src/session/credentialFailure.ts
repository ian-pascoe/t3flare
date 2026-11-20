// Why the Environment gave no credential for a Model endpoint (SPI-1162, SPI-1164), as a Session's turn, text generation
// and the model relay (SPI-1171) say it: typed, with a fixed text naming the endpoint and, for a sign-in, the sign-in.
import { type EndpointCredential, endpointLabel, type ModelEndpoint, signInOf } from "@t3flare/models/endpoints";
import type { EndpointCredentialFailure } from "@t3flare/session-protocol";

/** Why the Environment gave no credential for an endpoint, typed, with the turn's (or the text generation's) text. */
export const credentialFailure = (endpoint: Pick<ModelEndpoint, "id" | "auth">, { unreadable, changed, signedOut, problem }: EndpointCredential): EndpointCredentialFailure => {
  const named = endpointLabel(endpoint.id);
  const failure = (kind: EndpointCredentialFailure["kind"], message: string, retryable: boolean): EndpointCredentialFailure => ({ endpointId: endpoint.id, kind, message, retryable });
  const signIn = signInOf(endpoint.auth);
  if (changed === true) return failure("changed", `${named} changed or was removed since this Session took it: retry the turn.`, true);
  if (signIn !== undefined) {
    const why = problem === undefined ? "" : ` (${problem})`;
    return signedOut === true
      ? failure("signed_out", `${named} is not signed in to ${signIn.title}${why}: sign in with ${signIn.title} again on the Settings page.`, false)
      : failure("unavailable", `${named} could not get a ${signIn.title} token${why}: retry the turn.`, true);
  }
  return unreadable === true
    ? failure("unreadable", `${named}'s API key can no longer be read (this Environment's credentials key changed): enter it again on the Settings page.`, false)
    : failure("no_key", `${named} has no API key: set one on the Settings page.`, false);
};

/** Why the Environment gave no credential for an endpoint, as the turn (or the text generation) says it. */
export const credentialProblem = (endpoint: Pick<ModelEndpoint, "id" | "auth">, credential: EndpointCredential): string => credentialFailure(endpoint, credential).message;
