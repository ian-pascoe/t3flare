import type React from "react";
import { Interactive, interpolate } from "remotion";

type Props = {
  readonly children: React.ReactNode;
  // 0 open, 1 closed.
  readonly closeProgress: number;
  readonly style?: React.CSSProperties;
};

// A laptop in CSS 3D: the deck lies flat toward the viewer, the lid hinges on its bottom edge. The screen keeps
// playing as the lid closes and dims, then the lid's back shows.
const LaptopInner: React.FC<Props> = ({ children, closeProgress, style }) => {
  // Closed is -95deg: just above the deck's plane (84deg), so the lid rests on it rather than sinking through.
  const lidAngle = interpolate(closeProgress, [0, 1], [8, -95]);
  const dim = interpolate(closeProgress, [0, 0.85], [0, 0.6], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const screenW = 1280;
  const screenH = 800;
  return (
    <div style={{ position: "absolute", inset: 0, perspective: 2600, perspectiveOrigin: "50% 10%", ...style }}>
      <div style={{ position: "absolute", left: "50%", top: 900, transformStyle: "preserve-3d" }}>
        {/* Deck */}
        <div
          style={{
            position: "absolute",
            left: -(screenW + 120) / 2,
            top: 0,
            width: screenW + 120,
            height: 640,
            borderRadius: 28,
            transformOrigin: "50% 0",
            transform: "rotateX(84deg)",
            background: "linear-gradient(180deg, #2a2a2e 0%, #1b1b1e 100%)",
            boxShadow: "inset 0 0 0 2px #3a3a3e",
          }}
        >
          <div style={{ position: "absolute", left: 90, right: 90, top: 50, height: 330, borderRadius: 12, background: "#141416" }} />
          <div style={{ position: "absolute", left: "50%", translate: "-50% 0", top: 410, width: 480, height: 200, borderRadius: 14, background: "#26262b" }} />
        </div>
        {/* Lid */}
        <div
          style={{
            position: "absolute",
            left: -(screenW + 48) / 2,
            top: -(screenH + 48),
            width: screenW + 48,
            height: screenH + 48,
            transformOrigin: "50% 100%",
            transform: `rotateX(${lidAngle}deg)`,
            transformStyle: "preserve-3d",
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 26,
              background: "#17171a",
              boxShadow: "inset 0 0 0 2px #3a3a40, 0 0 80px rgba(255, 140, 40, 0.08)",
              backfaceVisibility: "hidden",
            }}
          >
            <div style={{ position: "absolute", left: 24, top: 24, width: screenW, height: screenH, borderRadius: 8, overflow: "hidden", background: "#000" }}>
              {children}
              <div style={{ position: "absolute", inset: 0, background: "#000", opacity: dim }} />
            </div>
          </div>
          <div
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: 26,
              background: "linear-gradient(180deg, #4a4a52 0%, #2c2c32 100%)",
              boxShadow: "inset 0 0 0 2px #5a5a62",
              transform: "rotateX(180deg)",
              backfaceVisibility: "hidden",
            }}
          />
        </div>
      </div>
    </div>
  );
};

export const Laptop = Interactive.create({
  Component: LaptopInner,
  layout: "none",
  schema: {
    closeProgress: { type: "number", default: 0, min: 0, max: 1, step: 0.01, description: "Lid closed", hiddenFromList: false },
  },
});
