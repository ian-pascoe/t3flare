import type React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { FLARE_GRADIENT, SANS, TEXT } from "../fonts";
import { Spark } from "./Spark";

type Props = {
  readonly size: number;
  readonly animate: boolean;
  // The colour of "t3": light on dark backgrounds, dark on light ones.
  readonly ink?: string;
  readonly style?: React.CSSProperties;
};

// Lowercase "t3flare": "t3" in neutral, "flare" in the gradient, the spark at the top right of the final "e".
// With animate, the spark streaks in first (frames 0-10), then the letters wipe in behind it (6-18).
const WordmarkInner: React.FC<Props> = ({ size, animate, ink = TEXT, style }) => {
  const frame = useCurrentFrame();
  const t = animate ? frame : 1000;
  const wipe = interpolate(t, [6, 18], [100, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const sparkScale = interpolate(t, [0, 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.spring({ damping: 200 }),
  });
  const streak = interpolate(t, [0, 6, 14], [0, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const glow = interpolate(t, [10, 24], [1, 0.35], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "relative", display: "inline-flex", alignItems: "baseline", ...style }}>
      <div
        style={{
          fontFamily: SANS,
          fontWeight: 600,
          fontSize: size,
          letterSpacing: "-0.03em",
          lineHeight: 1,
          clipPath: `inset(-20% ${wipe}% -20% 0)`,
        }}
      >
        <span style={{ color: ink }}>t3</span>
        <span style={{ backgroundImage: FLARE_GRADIENT, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>
          flare
        </span>
      </div>
      <div style={{ position: "absolute", right: -size * 0.32, top: -size * 0.12, scale: String(sparkScale) }}>
        <Spark size={size * 0.35} style={{ filter: `drop-shadow(0 0 ${size * 0.25 * glow}px rgba(255, 140, 40, 0.9))` }} />
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: size * 4,
            height: 2,
            translate: "-50% -50%",
            background: "linear-gradient(90deg, transparent, rgba(255, 181, 71, 0.9), transparent)",
            opacity: streak,
          }}
        />
      </div>
    </div>
  );
};

export const Wordmark = Interactive.create({
  Component: WordmarkInner,
  layout: "none",
  schema: {
    size: { type: "number", default: 120, min: 8, step: 1, description: "Size", hiddenFromList: false },
    animate: { type: "boolean", default: true, description: "Animate entrance" },
    ink: { type: "color", default: "#f5f5f5", description: "Colour of t3" },
  },
});
