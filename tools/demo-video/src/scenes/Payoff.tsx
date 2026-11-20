import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { AppWindow } from "../components/AppWindow";
import { Backdrop, Scrim } from "../components/Backdrop";
import { Caption } from "../components/Caption";
import { Footage } from "../components/Footage";
import "../fonts";

// Beat 3: the stock client's environment selector, listing the Laptop Environment and the Cloud Environment.
const PayoffInner = () => {
  const frame = useCurrentFrame();
  return (
    <>
      <Backdrop />
      <AppWindow
        name="Environment selector"
        zoom={interpolate(frame, [20, 70], [1, 2.2], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.65, 0, 0.35, 1),
        })}
        focus={[0.31, 0.66]}
      >
        <Footage name="Selector footage" clip="footage/switcher.mp4" trimBefore={0} />
      </AppWindow>
      <Scrim />
      <Caption
        name="Payoff caption"
        headline="The stock T3 Code clients."
        sub="A cloud Environment you own."
        highlight="you own"
        subAsHeadline
      />
    </>
  );
};

export const Payoff = Interactive.create({ Component: PayoffInner, layout: "absolute-fill" });
