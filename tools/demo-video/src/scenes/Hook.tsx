import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { Backdrop } from "../components/Backdrop";
import { Caption } from "../components/Caption";
import { Footage } from "../components/Footage";
import { Laptop } from "../components/Laptop";
import "../fonts";

// Beat 1: a real T3 Code thread on a laptop; the lid closes. Frame 0 already shows the open laptop, never black.
const HookInner = () => {
  const frame = useCurrentFrame();
  return (
    <>
      <Backdrop />
      <Laptop
        name="Laptop"
        closeProgress={interpolate(frame, [42, 84], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(0.65, 0, 0.35, 1),
        })}
        style={{ scale: "0.72", translate: "0px 40px" }}
      >
        <Footage name="Laptop screen" clip="footage/hook-turn.mp4" trimBefore={0} />
      </Laptop>
      <Caption name="Hook caption" headline="Close the laptop." style={{ bottom: "auto", top: 90 }} />
    </>
  );
};

export const Hook = Interactive.create({ Component: HookInner, layout: "absolute-fill" });
