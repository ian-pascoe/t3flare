import type React from "react";
import { useId } from "react";

// t3flare's mark: a four-point flare, wider than tall, each side a quadratic curve bent to the centre.
export const Spark: React.FC<{ readonly size: number; readonly style?: React.CSSProperties }> = ({ size, style }) => {
  const id = useId();
  return (
    <svg width={size * 1.8} height={size} viewBox="-18 -10 36 20" style={{ overflow: "visible", ...style }}>
      <defs>
        <linearGradient id={id} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#FF7A1A" />
          <stop offset="100%" stopColor="#FFB547" />
        </linearGradient>
      </defs>
      <path d="M0,-10 Q0,0 18,0 Q0,0 0,10 Q0,0 -18,0 Q0,0 0,-10 Z" fill={`url(#${id})`} />
    </svg>
  );
};
