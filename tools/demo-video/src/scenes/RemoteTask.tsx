import type React from "react";
import { Easing, Interactive, interpolate, Sequence, useCurrentFrame, useVideoConfig } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop, Scrim } from "../components/Backdrop";
import { Caption } from "../components/Caption";
import { Chip } from "../components/Chip";
import { Footage } from "../components/Footage";
import { PhoneNotification } from "../components/PhoneNotification";
import "../fonts";

type Props = {
  // Seconds into footage/remote-task.mp4, from its events file (remote-task.json): the child task showing "on t3flare",
  // and the laptop's turn ending with its report.
  readonly delegatedAt: number;
  readonly doneAt: number;
};

// The scene starts at frame 780 of the video; both land on beats of the music (820 and 881).
const LEAD = 40; // scene frames before the delegation lands, at real speed
const RUN_END = 101; // scene frame the remote run's end lands on, fast-forwarded from LEAD
const BANNER = 24; // the phone's banner, frames after it appears

// Real seconds of the remote run, shown while the footage runs faster than real time: the compression is disclosed.
const Elapsed: React.FC<{ readonly seconds: number }> = ({ seconds }) => {
  const frame = useCurrentFrame();
  const s = Math.round(interpolate(frame, [0, RUN_END - LEAD], [0, seconds], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  return <>{`▸▸ +${s}s`}</>;
};

// Beat 6: the laptop's agent delegates a Remote task to the Cloud Environment over its Peer link and waits on it; the
// child runs on t3flare while the Lineage panel follows it; then the phone gets T3 Connect's alert that it's done.
const RemoteTaskInner: React.FC<Props> = ({ delegatedAt, doneAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const slide = Easing.bezier(0.65, 0, 0.35, 1);
  return (
    <>
      <Backdrop />
      <AppWindow
        name="Remote task"
        zoom={interpolate(frame, [0, LEAD, RUN_END, RUN_END + 25], [1.55, 1.7, 1.7, 1.55], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: slide,
        })}
        focus={[0.56, 0.22]}
        style={{ translate: `${interpolate(frame, [RUN_END - 20, RUN_END + 10], [0, -140], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: slide })}px 0px` }}
      >
        <Sequence name="Delegating" durationInFrames={LEAD} layout="none">
          <Footage name="Delegating footage" clip="footage/remote-task.mp4" trimBefore={Math.round(delegatedAt * fps - LEAD)} />
        </Sequence>
        <Sequence name="Remote run" from={LEAD} durationInFrames={RUN_END - LEAD} layout="none">
          <Footage
            name="Remote run footage"
            clip="footage/remote-task.mp4"
            trimBefore={Math.round(delegatedAt * fps)}
            playbackRate={((doneAt - delegatedAt) * fps) / (RUN_END - LEAD)}
          />
        </Sequence>
        <Sequence name="Report" from={RUN_END} layout="none">
          <Footage name="Report footage" clip="footage/remote-task.mp4" trimBefore={Math.round(doneAt * fps)} />
        </Sequence>
      </AppWindow>
      <Scrim />
      <Caption
        name="Link caption"
        eyebrow="REMOTE TASK"
        headline="Delegate from your laptop."
        sub="Get pinged when it's done."
        style={{ left: 760 }}
      />
      <Sequence name="Run chip" from={LEAD} durationInFrames={RUN_END - LEAD} layout="none">
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 380, display: "flex", justifyContent: "center", gap: 16 }}>
          <Chip name="Running chip">Running on t3flare</Chip>
          <Chip name="Elapsed chip">
            <Elapsed seconds={Math.round(doneAt - delegatedAt)} />
          </Chip>
        </div>
      </Sequence>
      <Sequence name="Phone" from={RUN_END - BANNER} layout="none">
        <PhoneNotification name="Run finished alert" app="T3 Code" title="Add Modulo Script With Tests" body="Done: t3flare-fixture" bannerAt={BANNER} />
      </Sequence>
    </>
  );
};

export const RemoteTask = Interactive.create({
  Component: RemoteTaskInner,
  layout: "absolute-fill",
  schema: {
    delegatedAt: { type: "number", default: 14.9, min: 0, step: 0.1, description: "Delegated at (s in clip)", hiddenFromList: false },
    doneAt: { type: "number", default: 40.9, min: 0, step: 0.1, description: "Turn done at (s in clip)", hiddenFromList: false },
  },
});
