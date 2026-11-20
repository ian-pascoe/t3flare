import type React from "react";
import { Easing, Interactive, interpolate, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop, Scrim } from "../components/Backdrop";
import { Caption } from "../components/Caption";
import { Chip } from "../components/Chip";
import { Footage } from "../components/Footage";
import "../fonts";

type Props = {
  // Seconds into footage/durable-restart.mp4, from its events file (durable-restart.json): the restart request,
  // the stock "T3 Code restarted and resumed this turn" notice, and the turn's end.
  readonly restartAt: number;
  readonly noticeAt: number;
  readonly doneAt: number;
};

const RESTART = 40; // scene frame the restart lands on: a beat of the music (frame 498 of the video)
const NOTICE = 70; // scene frame the notice lands on
const DONE = 150; // scene frame the turn's end lands on

// Real seconds since the restart, shown while the footage runs faster than real time: the compression is disclosed.
const Elapsed: React.FC<{ readonly seconds: readonly [number, number] }> = ({ seconds }) => {
  const frame = useCurrentFrame();
  const s = Math.round(interpolate(frame, [0, DONE - RESTART], seconds, { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  return <>{`▸▸ +${s}s`}</>;
};

// Beat 4: a Pi Durable turn inside a bash call; the Environment restarts (POST /_t3flare/restart); t3 cancels the
// run and re-prompts it; the agent checks the cut command and finishes. ADR-0004: a restart costs a re-prompt,
// never the conversation.
const DurableInner: React.FC<Props> = ({ restartAt, noticeAt, doneAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const hit = frame >= RESTART && frame < RESTART + 8;
  const jitter = hit ? Math.sin(frame * 7.3) * 14 : 0;
  return (
    <>
      <Backdrop />
      <div
        style={{
          position: "absolute",
          inset: 0,
          translate: `${jitter}px 0`,
          filter: hit ? "drop-shadow(4px 0 0 rgba(255,0,60,0.75)) drop-shadow(-4px 0 0 rgba(0,200,255,0.75)) brightness(0.55)" : "none",
        }}
      >
        <AppWindow
          name="Durable thread"
          zoom={interpolate(frame, [0, RESTART, NOTICE, NOTICE + 20], [1.75, 1.85, 1.85, 2.1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.65, 0, 0.35, 1),
          })}
          focus={[0.5, 0.33]}
        >
          <Sequence name="Before the restart" durationInFrames={RESTART} layout="none">
            <Footage name="Turn running" clip="footage/durable-restart.mp4" trimBefore={Math.round(restartAt * fps - RESTART)} />
          </Sequence>
          <Sequence name="Restarting" from={RESTART} durationInFrames={NOTICE - RESTART} layout="none">
            <Footage
              name="Restarting footage"
              clip="footage/durable-restart.mp4"
              trimBefore={Math.round(restartAt * fps)}
              playbackRate={((noticeAt - restartAt) * fps) / (NOTICE - RESTART)}
            />
          </Sequence>
          <Sequence name="Resumed" from={NOTICE} durationInFrames={DONE - NOTICE} layout="none">
            <Footage
              name="Resumed footage"
              clip="footage/durable-restart.mp4"
              trimBefore={Math.round(noticeAt * fps)}
              playbackRate={((doneAt - noticeAt) * fps) / (DONE - NOTICE)}
            />
          </Sequence>
          <Sequence name="Done" from={DONE} layout="none">
            <Footage name="Done footage" clip="footage/durable-restart.mp4" trimBefore={Math.round(doneAt * fps)} />
          </Sequence>
        </AppWindow>
        {hit ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background:
                "repeating-linear-gradient(180deg, rgba(255,255,255,0.08) 0 3px, transparent 3px 9px), linear-gradient(180deg, transparent 38%, rgba(255,255,255,0.12) 38% 41%, transparent 41% 63%, rgba(0,0,0,0.6) 63% 67%, transparent 67%)",
            }}
          />
        ) : null}
      </div>
      <Scrim />
      <Caption
        name="Durable caption"
        eyebrow="DURABLE AGENTS"
        headline="Restart mid-turn. It carries on."
        sub="A restart costs a re-prompt, never the conversation."
      />
      <Sequence name="Restart chips" from={RESTART} durationInFrames={DONE - RESTART} layout="none">
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 380, display: "flex", justifyContent: "center", gap: 16 }}>
          <Chip name="Restarted chip">Environment restarted</Chip>
          <Chip name="Elapsed chip">
            <Elapsed seconds={[0, Math.round(doneAt - restartAt)]} />
          </Chip>
        </div>
      </Sequence>
    </>
  );
};

export const Durable = Interactive.create({
  Component: DurableInner,
  layout: "absolute-fill",
  schema: {
    restartAt: { type: "number", default: 47.2, min: 0, step: 0.1, description: "Restart at (s in clip)", hiddenFromList: false },
    noticeAt: { type: "number", default: 50, min: 0, step: 0.1, description: "Notice at (s in clip)", hiddenFromList: false },
    doneAt: { type: "number", default: 72.7, min: 0, step: 0.1, description: "Turn done at (s in clip)", hiddenFromList: false },
  },
});
