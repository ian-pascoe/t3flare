// Records the launch video's footage from real T3 Code desktop, against a throwaway t3flare Stage (README.md).
//
//   mise exec -- pnpm capture launch         start the isolated instance (idempotent) and attach
//   mise exec -- pnpm capture stop           quit it
//   mise exec -- pnpm capture shot <name>    record one shot into public/footage/<name>.mp4
//   mise exec -- pnpm capture all            record every shot
import { attach } from "./ab.ts";
import { floatWindow, launch, stop } from "./instance.ts";
import { SHOTS, recordShot } from "./shots.ts";

const [command, name] = process.argv.slice(2);

switch (command) {
  case "launch":
    console.log(`instance pid ${await launch()}`);
    floatWindow();
    await attach();
    break;
  case "stop":
    await stop();
    break;
  case "shot": {
    if (!name || !(name in SHOTS)) throw new Error(`usage: capture shot <${Object.keys(SHOTS).join("|")}>`);
    await launch();
    floatWindow();
    await attach();
    await recordShot(name);
    break;
  }
  case "all":
    await launch();
    floatWindow();
    await attach();
    for (const shot of Object.keys(SHOTS)) await recordShot(shot);
    break;
  default:
    console.error("usage: capture launch | stop | shot <name> | all");
    process.exit(2);
}
