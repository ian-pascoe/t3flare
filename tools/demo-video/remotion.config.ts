// CLI renders (pnpm render, pnpm still) read this; the Node APIs do not.
import { Config } from "@remotion/cli/config";

Config.setRspack(true);
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(95);
Config.setOverwriteOutput(true);
Config.setDefaultPremountInSeconds(2);
Config.setCodec("h264");
Config.setCrf(16);
Config.setPixelFormat("yuv420p");
