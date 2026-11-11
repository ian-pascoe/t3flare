// @effect-diagnostics globalDate:off globalConsole:off nodeBuiltinImport:off globalTimers:off
// SPI-993's stage check: an image attached in t3 reaches the Durable agent. Through t3's own client protocol it persists
// a small solid green PNG (`assets.persistChatAttachments`, as the web client does), sends it on claude-haiku-5-5 and
// asks for the colour; then sends an image past the Session's inline budget and checks the turn still completes, with
// the agent told the image was not shown. Run against a stage:
//
//   bun scripts/stage.ts run <stage> attachments [--out file.json]
import { WS_METHODS } from "@t3tools/contracts";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { deflateSync } from "node:zlib";

import { createProjectAndThread, itemsOf, pair, runsOf, sendMessage, SETTLED, uuid, waitFor, wsCall } from "./lib/client.ts";

const outIndex = process.argv.indexOf("--out");
const out = outIndex === -1 ? undefined : process.argv[outIndex + 1];
const report: Record<string, unknown> = { at: new Date().toISOString() };
const failures: Array<string> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${name}: ${JSON.stringify(detail ?? null).slice(0, 400)}`);
};

/** A PNG of `width`×`height` RGB pixels from `pixel(x, y)`. */
const png = (width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number]): Buffer => {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) rows.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
};

const persist = async (cookie: string, threadId: string, messageId: string, name: string, bytes: Buffer) => {
  const result = (await wsCall(cookie, WS_METHODS.assetsPersistChatAttachments, {
    threadId,
    messageId,
    attachments: [{ type: "image", name, mimeType: "image/png", sizeBytes: bytes.length, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` }],
  })) as { attachments: Array<Record<string, unknown>> };
  return result.attachments;
};

const assistantText = (projection: any, after: number) =>
  itemsOf(projection)
    .filter((item: any) => item.type === "assistant_message")
    .slice(after)
    .map((item: any) => item.text)
    .join("\n");

const cookie = await pair();
// A new Environment has the provider off (onboarding turns it on), as scripts/models.ts does.
await wsCall(cookie, "server.updateSettings", {
  patch: {},
  providerInstanceMutation: { operation: "upsert", instanceId: "piDurable", instance: { driver: "piDurable", enabled: true } },
});
const stamp = Date.now().toString(36);
const { threadId } = await createProjectAndThread(cookie, { title: `attachments ${stamp}`, workspaceRoot: `/t3/home/attachments-${stamp}` });

// 1. A green square: the model must see it to name the colour.
const green = png(64, 64, () => [20, 190, 40]);
const firstId = uuid();
const firstAttachments = await persist(cookie, threadId, firstId, "square.png", green);
await sendMessage(cookie, threadId, "What colour is the attached image? Answer with one lowercase word.", undefined, {
  messageId: firstId,
  attachments: firstAttachments,
});
const first = await waitFor(cookie, threadId, (p) => runsOf(p).filter((r) => SETTLED.has(r.status)).length >= 1);
const firstAnswer = assistantText(first.projection, 0);
const userMessage = (first.projection?.messages ?? []).find((m: any) => m.id === firstId);
report.colour = {
  ms: first.ms,
  imageBytes: green.length,
  run: runsOf(first.projection).map((r) => r.status),
  answer: firstAnswer,
  userMessageAttachments: userMessage?.attachments ?? null,
};
check("the run completed", runsOf(first.projection)[0]?.status === "completed", runsOf(first.projection));
check("the model named the colour", /\bgreen\b/i.test(firstAnswer), firstAnswer);
check("t3's user message keeps the attachment", (userMessage?.attachments?.length ?? 0) === 1, userMessage ?? null);

// 2. Noise past the inline budget (about 1.2 MB of PNG): the turn completes, and the agent is told it was not shown.
const random = randomBytes(640 * 640 * 3);
const big = png(640, 640, (x, y) => {
  const at = (y * 640 + x) * 3;
  return [random[at]!, random[at + 1]!, random[at + 2]!];
});
const secondId = uuid();
const secondAttachments = await persist(cookie, threadId, secondId, "noise.png", big);
const before = itemsOf(first.projection).filter((item: any) => item.type === "assistant_message").length;
await sendMessage(
  cookie,
  threadId,
  "Can you see the image attached to this message? If you were told it is not shown, answer exactly: not shown. Otherwise answer: shown.",
  undefined,
  { messageId: secondId, attachments: secondAttachments },
);
const second = await waitFor(cookie, threadId, (p) => runsOf(p).filter((r) => SETTLED.has(r.status)).length >= 2);
const secondAnswer = assistantText(second.projection, before);
report.overBudget = { ms: second.ms, imageBytes: big.length, run: runsOf(second.projection).map((r) => r.status), answer: secondAnswer };
check("the over-budget run completed", runsOf(second.projection).every((r) => r.status === "completed"), runsOf(second.projection));
check("the agent was told the image is not shown", /not shown/i.test(secondAnswer), secondAnswer);

report.ok = failures.length === 0;
report.failures = failures;
console.log(JSON.stringify(report, null, 2));
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
