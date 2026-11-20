import type React from "react";
import { AbsoluteFill } from "remotion";

// Black, with a faint warm glow, and a scrim that keeps the lower-third caption legible over footage.
export const Backdrop: React.FC<{ readonly glow?: boolean }> = ({ glow = true }) => (
  <AbsoluteFill
    style={{
      background: glow ? "radial-gradient(70% 60% at 50% 110%, rgba(255, 122, 26, 0.16) 0%, rgba(0, 0, 0, 0) 70%), #000" : "#000",
    }}
  />
);

export const Scrim: React.FC = () => (
  <AbsoluteFill
    style={{
      background: "linear-gradient(180deg, rgba(0,0,0,0) 52%, rgba(0,0,0,0.78) 74%, rgba(0,0,0,0.94) 100%)",
      pointerEvents: "none",
    }}
  />
);
