import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop, Scrim } from "../components/Backdrop";
import { Caption } from "../components/Caption";
import { Footage } from "../components/Footage";
import "../fonts";

// Beat 5: the Cloud Environment's real provider picker: Codex, Claude Code, OpenCode, pi and Pi Durable, each
// on the Owner's Model endpoints. Every row shows as the client shows it; the zoom picks out the five.
const CliAgentsInner = () => {
  const frame = useCurrentFrame();
  return (
    <>
      <Backdrop />
      <AppWindow
        name="Provider picker"
        zoom={interpolate(frame, [0, 40], [1.2, 1.9], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.65, 0, 0.35, 1),
        })}
        focus={[0.42, 0.22]}
      >
        <Footage name="Picker footage" clip="footage/providers.mp4" trimBefore={24} playbackRate={2} />
      </AppWindow>
      <Scrim />
      <Caption name="CLI caption" eyebrow="CLI AGENTS" headline="Your model endpoints." sub="No vendor keys in the box." />
    </>
  );
};

export const CliAgents = Interactive.create({ Component: CliAgentsInner, layout: "absolute-fill" });
