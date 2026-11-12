// @effect-diagnostics globalDate:off
// Step 4a M0 P1 (stage only, removed by M1's channel): one long-lived non-PTY exec in the Container, its stdin piped,
// stdout and stderr read separately and kept in memory with their arrival times, its exit code kept. Driven by the
// admin route `workspace-call` {probeProcess: …} on stages with T3FLARE_FAULTS.

export interface ProbeExec {
  readonly stdin: WritableStream | null;
  readonly stdout: ReadableStream | null;
  readonly stderr: ReadableStream | null;
  readonly exitCode: Promise<number>;
}

export type ProbeOp =
  | { readonly op: "start"; readonly key: string; readonly argv: ReadonlyArray<string>; readonly env?: Readonly<Record<string, string>> }
  | { readonly op: "write"; readonly key: string; readonly text: string }
  | { readonly op: "close-stdin"; readonly key: string }
  | { readonly op: "state"; readonly key: string; readonly since?: number };

interface Probe {
  readonly started: number;
  readonly writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  readonly chunks: Array<{ readonly at: number; readonly stream: "stdout" | "stderr"; readonly text: string }>;
  exit: { readonly code: number; readonly at: number } | null;
  readError: string | null;
}

const encoder = new TextEncoder();

export class ProcessProbe {
  readonly #probes = new Map<string, Probe>();

  get live(): number {
    return [...this.#probes.values()].filter((probe) => probe.exit === null).length;
  }

  async run(op: ProbeOp, exec: (argv: ReadonlyArray<string>, env: Record<string, string>) => Promise<ProbeExec>): Promise<unknown> {
    switch (op.op) {
      case "start": {
        const process = await exec(op.argv, { ...op.env });
        const probe: Probe = { started: Date.now(), writer: process.stdin?.getWriter() as WritableStreamDefaultWriter<Uint8Array> | undefined, chunks: [], exit: null, readError: null };
        this.#probes.set(op.key, probe);
        const read = async (stream: ReadableStream | null, name: "stdout" | "stderr") => {
          if (stream === null) return;
          const reader = stream.getReader();
          const decoder = new TextDecoder();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              probe.chunks.push({ at: Date.now() - probe.started, stream: name, text: decoder.decode(value as Uint8Array, { stream: true }) });
            }
          } catch (error) {
            probe.readError = `${name}: ${String(error).slice(0, 200)}`;
          }
        };
        void read(process.stdout, "stdout");
        void read(process.stderr, "stderr");
        void process.exitCode.then(
          (code) => (probe.exit = { code, at: Date.now() - probe.started }),
          (error: unknown) => {
            probe.readError = `exit: ${String(error).slice(0, 200)}`;
            probe.exit = { code: -1, at: Date.now() - probe.started };
          },
        );
        return { started: true };
      }
      case "write": {
        const probe = this.#probes.get(op.key);
        if (probe?.writer === undefined) return { error: "no such probe" };
        await probe.writer.write(encoder.encode(op.text));
        return { written: op.text.length };
      }
      case "close-stdin": {
        const probe = this.#probes.get(op.key);
        await probe?.writer?.close();
        return { closed: probe !== undefined };
      }
      case "state": {
        const probe = this.#probes.get(op.key);
        if (probe === undefined) return { known: false };
        return { known: true, ageMs: Date.now() - probe.started, exit: probe.exit, readError: probe.readError, chunks: probe.chunks.slice(op.since ?? 0), total: probe.chunks.length };
      }
    }
  }
}
