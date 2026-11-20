import { Easing, Interactive, interpolate, Sequence, useCurrentFrame } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop, Scrim } from "../components/Backdrop";
import { Caption } from "../components/Caption";
import { Footage } from "../components/Footage";
import { PhoneNotification } from "../components/PhoneNotification";
import "../fonts";

// Beat 6: the laptop's thread delegates a task to the Cloud Environment (a Remote task over a Peer link); then the
// phone gets T3 Connect's alert that the run is done.
const LaptopLinkInner = () => {
  const frame = useCurrentFrame();
  return (
    <>
      <Backdrop />
      <AppWindow
        name="Remote task"
        zoom={interpolate(frame, [0, 90], [1.15, 1.45], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.65, 0, 0.35, 1),
        })}
        focus={[0.55, 0.6]}
        style={{ translate: `${interpolate(frame, [80, 110], [0, -140], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.65, 0, 0.35, 1) })}px 0px` }}
      >
        <Footage name="Remote task footage" clip="footage/remote-task.mp4" trimBefore={0} playbackRate={2} />
      </AppWindow>
      <Scrim />
      <Caption
        name="Link caption"
        eyebrow="LAPTOP LINK"
        headline="Delegate from your laptop."
        sub="Get pinged when it's done."
        style={{ left: 760 }}
      />
      <Sequence name="Phone" from={84} layout="none">
        <PhoneNotification name="Run finished alert" app="T3 Code" title="Add a modulo script" body="Done: t3flare-fixture" bannerAt={24} />
      </Sequence>
    </>
  );
};

export const LaptopLink = Interactive.create({ Component: LaptopLinkInner, layout: "absolute-fill" });
