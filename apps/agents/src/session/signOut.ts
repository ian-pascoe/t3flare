// What a Session does when a sign-in endpoint is signed out (SPI-1164): it drops the endpoint's token from memory, and
// stops its live turns when they run on that endpoint. Which endpoint its turns run on is kept in the Session's own
// storage at each turn's start, so the answer holds after either object restarts (the Environment keeps no such map).

/** The provider (a Model endpoint's id) of the model the Session's last turn ran on. */
export const TURN_PROVIDER_KEY = "t3flare:turn-provider";

interface Kv {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
}

/** A turn starts on `provider`'s model. */
export const noteTurnProvider = (kv: Kv, provider: string): void => {
  if (kv.get<string>(TURN_PROVIDER_KEY) !== provider) kv.put(TURN_PROVIDER_KEY, provider);
};

/** Whether the Session's turns run on `endpointId`, so its sign-out stops them. */
export const runsOn = (kv: Kv, endpointId: string): boolean => kv.get<string>(TURN_PROVIDER_KEY) === endpointId;
