// @effect-diagnostics nodeBuiltinImport:off
// The Container image (step 2a plan, section 5).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The Docker build context of the image: the directory with its Dockerfile. The stack builds the Workspace DO's Container from it. */
export const sandboxImageContext = join(dirname(fileURLToPath(import.meta.url)), "..", "image");

export * from "./env.ts";
