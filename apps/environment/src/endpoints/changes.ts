// Who hears that the Model endpoints changed (SPI-1162): the Pi Durable driver, which builds its picker's snapshot again at
// once rather than at its next check. Module state, as the Environment DO is the only object in its isolate.
const listeners = new Set<() => void>();

/** Hear each change; the answer stops hearing. */
export const onEndpointsChanged = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The endpoints changed: tell every listener (a listener that throws never stops the others). */
export const endpointsChanged = (): void => {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A listener's failure is its own.
    }
  }
};
