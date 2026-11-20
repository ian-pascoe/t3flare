import type React from "react";
import { Interactive } from "remotion";
import { BORDER } from "../fonts";

type Props = {
  readonly children: React.ReactNode;
  // Zoom into the footage, toward focus (0-1 in each axis, from the top left).
  readonly zoom: number;
  readonly focus: readonly [number, number];
  readonly style?: React.CSSProperties;
};

// A macOS window around real T3 Code footage. The app's title bar is hidden-inset, so the footage's top strip is
// empty where the traffic lights sit; they are drawn here. 1600 x 900, centred.
const W = 1600;
const H = 900;
// Where the focus point drifts to as the zoom grows: upper centre, clear of the lower-third caption.
const ANCHOR = [0.5, 0.36] as const;

const AppWindowInner: React.FC<Props> = ({ children, zoom, focus, style }) => {
  const drift = 1 - 1 / zoom;
  const at = (axis: 0 | 1, size: number) => {
    const pos = (focus[axis] + (ANCHOR[axis] - focus[axis]) * drift) * size;
    const t = pos - focus[axis] * size * zoom;
    return Math.min(0, Math.max(size - size * zoom, t));
  };
  return (
    <div
      style={{
        position: "absolute",
        left: 160,
        top: 90,
        width: W,
        height: H,
        borderRadius: 18,
        overflow: "hidden",
        border: `1px solid ${BORDER}`,
        background: "#000",
        boxShadow: "0 40px 120px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(0, 0, 0, 0.6)",
        ...style,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          transformOrigin: "0 0",
          translate: `${at(0, W)}px ${at(1, H)}px`,
          scale: String(zoom),
        }}
      >
        {children}
      </div>
      <div style={{ position: "absolute", left: 20, top: 18, display: "flex", gap: 9 }}>
        <div style={{ width: 13, height: 13, borderRadius: 99, background: "#ff5f57" }} />
        <div style={{ width: 13, height: 13, borderRadius: 99, background: "#febc2e" }} />
        <div style={{ width: 13, height: 13, borderRadius: 99, background: "#28c840" }} />
      </div>
    </div>
  );
};

export const AppWindow = Interactive.create({
  Component: AppWindowInner,
  layout: "none",
  schema: {
    zoom: { type: "number", default: 1, min: 1, max: 4, step: 0.01, description: "Zoom", hiddenFromList: false },
    focus: { type: "uv-coordinate", default: [0.5, 0.5], description: "Zoom focus" },
  },
});
