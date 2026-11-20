import { Easing, Interactive, interpolate, Sequence, useCurrentFrame } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop, Scrim } from "../components/Backdrop";
import { Caption } from "../components/Caption";
import { Footage } from "../components/Footage";
import { Wordmark } from "../components/Wordmark";
import { MONO, MUTED } from "../fonts";

// Beat 2: the same thread, later in the take, still working in the Cloud Environment. Then the wordmark.
const TurnInner = () => {
  const frame = useCurrentFrame();
  return (
    <>
      <Backdrop />
      <AppWindow
        name="Cloud thread"
        zoom={interpolate(frame, [0, 135], [1.9, 2.15], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}
        focus={[0.45, 0.3]}
      >
        <Footage name="Cloud thread footage" clip="footage/hook-turn.mp4" trimBefore={21 * 30} playbackRate={2} />
      </AppWindow>
      <Scrim />
      <Caption name="Turn caption" headline="Your agents keep working." exitAt={58} />
      <Sequence name="Wordmark reveal" from={66} layout="none">
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 150, display: "flex", flexDirection: "column", alignItems: "center", gap: 22 }}>
          <Wordmark name="Wordmark" size={120} animate />
          <Interactive.Div
            name="Tagline"
            style={{
              fontFamily: MONO,
              fontSize: 32,
              color: MUTED,
              opacity: interpolate(frame, [80, 92], [0, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.bezier(0.16, 1, 0.3, 1),
              }),
            }}
          >
            a self-hosted cloud Environment for T3 Code
          </Interactive.Div>
        </div>
      </Sequence>
    </>
  );
};

export const Turn = Interactive.create({ Component: TurnInner, layout: "absolute-fill" });
