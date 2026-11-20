import type React from "react";
import { Interactive } from "remotion";

type Props = {
  readonly children: React.ReactNode;
  readonly style?: React.CSSProperties;
};

// A small mono label in the caption zone, never over the client's UI: "Environment restarted", "▸▸ 0:45".
const ChipInner: React.FC<Props> = ({ children, style }) => (
  <div
    style={{
      position: "relative",
      padding: "10px 20px",
      borderRadius: 999,
      border: "1px solid rgba(255, 181, 71, 0.45)",
      background: "rgba(20, 12, 4, 0.85)",
      color: "#FFB547",
      fontFamily: "'Geist Mono', ui-monospace, monospace",
      fontSize: 28,
      whiteSpace: "nowrap",
      ...style,
    }}
  >
    {children}
  </div>
);

export const Chip = Interactive.create({
  Component: ChipInner,
  layout: "none",
  schema: {
    ...Interactive.childrenSchema,
  },
});
