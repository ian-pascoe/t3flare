import type React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { FLARE_GRADIENT, MONO, MUTED, SANS, TEXT } from "../fonts";

type Props = {
  readonly eyebrow?: string;
  readonly headline: string;
  readonly sub?: string;
  // Words of the headline or sub shown in the flare gradient, e.g. "you own".
  readonly highlight?: string;
  // Sub-line in the headline's size (beat 3's two-line statement) rather than as supporting text.
  readonly subAsHeadline?: boolean;
  readonly exitAt?: number;
  readonly style?: React.CSSProperties;
};

const Words: React.FC<{ text: string; highlight: string; start: number; exitAt: number }> = ({ text, highlight, start, exitAt }) => {
  const frame = useCurrentFrame();
  const words = text.split(" ");
  const hl = new Set(highlight.split(" ").filter(Boolean));
  return (
    <>
      {words.map((word, i) => {
        const at = start + i * 3;
        const enter = interpolate(frame, [at, at + 12], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.spring({ damping: 200 }),
        });
        const exit = interpolate(frame, [exitAt, exitAt + 8], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const gradient = hl.has(word.replace(/[.,]$/, ""));
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              whiteSpace: "pre",
              opacity: enter * exit,
              translate: `0 ${(1 - enter) * 24}px`,
              ...(gradient ? { backgroundImage: FLARE_GRADIENT, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" } : {}),
            }}
          >
            {word}
            {i < words.length - 1 ? " " : ""}
          </span>
        );
      })}
    </>
  );
};

// A lower third: optional mono eyebrow, the headline revealed word by word, an optional sub-line.
// Sits 100 px above the bottom, at most 1400 px wide.
const CaptionInner: React.FC<Props> = ({ eyebrow = "", headline, sub = "", highlight = "", subAsHeadline = false, exitAt = 10000, style }) => {
  const frame = useCurrentFrame();
  const eyebrowIn = interpolate(frame, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const eyebrowOut = interpolate(frame, [exitAt, exitAt + 8], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const headStart = eyebrow ? 4 : 0;
  const subStart = headStart + headline.split(" ").length * 3 + 8;
  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        bottom: 100,
        translate: "-50% 0",
        width: 1400,
        textAlign: "center",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 14,
        ...style,
      }}
    >
      {eyebrow ? (
        <div style={{ fontFamily: MONO, fontSize: 26, letterSpacing: "0.18em", color: "#FFB547", opacity: eyebrowIn * eyebrowOut }}>{eyebrow}</div>
      ) : null}
      <div style={{ fontFamily: SANS, fontWeight: 600, fontSize: 88, lineHeight: 1.05, letterSpacing: "-0.025em", color: TEXT }}>
        <Words text={headline} highlight={highlight} start={headStart} exitAt={exitAt} />
      </div>
      {sub ? (
        <div
          style={
            subAsHeadline
              ? { fontFamily: SANS, fontWeight: 600, fontSize: 88, lineHeight: 1.05, letterSpacing: "-0.025em", color: TEXT }
              : { fontFamily: SANS, fontWeight: 500, fontSize: 40, lineHeight: 1.25, color: MUTED }
          }
        >
          <Words text={sub} highlight={highlight} start={subStart} exitAt={exitAt} />
        </div>
      ) : null}
    </div>
  );
};

export const Caption = Interactive.create({
  Component: CaptionInner,
  layout: "none",
  schema: {
    eyebrow: { type: "string", default: "", description: "Eyebrow" },
    headline: { type: "string", default: "Headline", description: "Headline" },
    sub: { type: "string", default: "", description: "Sub-line" },
    highlight: { type: "string", default: "", description: "Gradient words" },
    subAsHeadline: { type: "boolean", default: false, description: "Sub-line as large as the headline" },
    exitAt: { type: "number", default: 10000, min: 0, step: 1, description: "Exit at frame", hiddenFromList: false },
  },
});
