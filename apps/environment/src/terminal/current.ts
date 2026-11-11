// This Environment DO instance's terminals (step 2b), apart from the TerminalManager Layer so the DO's module graph
// never loads t3 before it boots (step 0's startup limit): `EnvironmentDO.terminalOutput` delivers through it.
import type { TerminalProcesses } from "./ptyAdapter.ts";

let current: TerminalProcesses | undefined;

export const currentTerminals = (): TerminalProcesses | undefined => current;

export const setCurrentTerminals = (processes: TerminalProcesses): void => {
  current = processes;
};

/** A new Environment DO instance in a warm isolate starts with none (ADR-0003: module state outlives a reset). */
export const resetTerminals = (): void => {
  current = undefined;
};
