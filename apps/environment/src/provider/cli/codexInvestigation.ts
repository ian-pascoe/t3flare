// @effect-diagnostics globalJsonInEffect:off effectFnOpportunity:off
// The Codex driver's investigating text generation (parity G7, SPI-998): t3's PR review guide asks a coding agent to
// read a checkout read-only (`TextGenerationOperations.Request.investigate`), and stock t3 runs `codex exec -s
// read-only` with the checkout as its cwd (`CodexTextGeneration.runCodexJson`). Here the same run happens in the
// checkout's Container (a scratch checkout, `agents/scratch.ts`), through the process channel and the CLI profile
// (`cliProfiles.ts` `codexExecLaunch`): the output schema goes there from the State directory, and the answer is the
// last agent message of `--json`'s event stream, since `--output-last-message` would write it in the Container.
// Every other operation keeps the proxy's text generation (`textGeneration.ts`).
import { TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { toJsonSchemaObject } from "@t3tools/provider-core/server/textGenerationUtils";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { codexExecArgs } from "../../agents/cliProfiles.ts";

const fail = (operation: TextGenerationOperations.Operation, detail: string, cause?: unknown) =>
  new TextGenerationError({ operation, detail, ...(cause === undefined ? {} : { cause }) });

/** What `codex exec --json` said: its last agent message, or the reason the turn failed. */
export const execOutcome = (jsonl: string): { readonly message: string } | { readonly error: string } => {
  let message: string | undefined;
  let error: string | undefined;
  for (const line of jsonl.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: string; item?: { type?: string; text?: string }; error?: { message?: string }; message?: string };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") message = event.item.text;
    else if (event.type === "turn.failed") error = event.error?.message ?? "the turn failed";
    else if (event.type === "error" && typeof event.message === "string") error = event.message;
  }
  if (message !== undefined && message.trim() !== "") return { message };
  return { error: error ?? "Codex gave no answer" };
};

const text = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

/** `run` with `investigate` requests answered by `codex exec -s read-only` in the cwd's Container. */
export const withCodexInvestigation =
  (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], fileSystem: FileSystem.FileSystem, run: TextGenerationOperations.Runner): TextGenerationOperations.Runner =>
  (request) => {
    if (request.investigate === undefined) return run(request);
    const operation = request.operation;
    const timeoutMs = request.investigate.timeoutMs;
    return Effect.gen(function* () {
      const schemaPath = yield* fileSystem.makeTempFile({ prefix: "t3flare-codex-schema-" }).pipe(Effect.mapError((cause) => fail(operation, "Failed to write temp file", cause)));
      const answer = yield* Effect.gen(function* () {
        yield* fileSystem
          .writeFileString(schemaPath, JSON.stringify(toJsonSchemaObject(request.outputSchema)))
          .pipe(Effect.mapError((cause) => fail(operation, "Failed to write temp file", cause)));
        const child = yield* spawner
          .spawn(
            ChildProcess.make("codex", [...codexExecArgs(request.modelSelection.model, schemaPath)], {
              cwd: request.cwd,
              stdin: { stream: Stream.encodeText(Stream.make(request.prompt)) },
            }),
          )
          .pipe(Effect.mapError((cause) => fail(operation, `Failed to spawn Codex CLI process: ${String(cause).slice(0, 300)}`, cause)));
        const [stdout, stderr, exitCode] = yield* Effect.all([text(child.stdout), text(child.stderr), child.exitCode], { concurrency: "unbounded" }).pipe(
          Effect.mapError((cause) => fail(operation, "Failed to collect process output", cause)),
        );
        const outcome = execOutcome(stdout);
        if ("error" in outcome) {
          const detail = exitCode !== 0 && stderr.trim() !== "" ? stderr.trim().slice(-2000) : outcome.error;
          return yield* fail(operation, `Codex CLI command failed: ${detail}`);
        }
        return outcome.message;
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(timeoutMs),
        Effect.ensuring(fileSystem.remove(schemaPath).pipe(Effect.ignore)),
      );
      if (Option.isNone(answer)) return yield* fail(operation, "Codex CLI request timed out.");
      return yield* TextGenerationOperations.decodeJsonReply(request, "Codex", answer.value);
    });
  };
