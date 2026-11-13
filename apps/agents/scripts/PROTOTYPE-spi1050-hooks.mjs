// PROTOTYPE (SPI-1050 probe): stand in for cloudflare:workers under Node.
import { registerHooks } from "node:module";
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") return { url: "data:text/javascript,export class RpcTarget{} export class WorkerEntrypoint{} export class DurableObject{} export const env={};", shortCircuit: true };
    return next(spec, ctx);
  },
});
