// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Allows GitHub Actions to create pull requests on the repository, which the nightly bump job needs to propose a new
// pin (.github/workflows/bump.yml). No alchemy resource covers the setting, so `ci:setup` runs this after the stack.
// Keeps the default workflow token read-only; the bump workflow asks for `contents` and `pull-requests` itself.
import { execFileSync } from "node:child_process";

const repository = process.env["GITHUB_REPOSITORY"] ?? "ian-pascoe/t3flare";
const endpoint = `repos/${repository}/actions/permissions/workflow`;

execFileSync(
  "gh",
  ["api", "--method", "PUT", endpoint, "-f", "default_workflow_permissions=read", "-F", "can_approve_pull_request_reviews=true"],
  { stdio: "inherit" },
);
const settings = JSON.parse(execFileSync("gh", ["api", endpoint], { encoding: "utf8" })) as {
  default_workflow_permissions: string;
  can_approve_pull_request_reviews: boolean;
};
console.log(
  `${repository}: default workflow permissions ${settings.default_workflow_permissions}, Actions may create pull requests: ${settings.can_approve_pull_request_reviews}`,
);
