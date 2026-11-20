import type React from "react";
import { Easing, Interactive, interpolate, Sequence, useCurrentFrame } from "remotion";
import { Backdrop } from "../components/Backdrop";
import { Wordmark } from "../components/Wordmark";
import "../fonts";

// The URL types on with a block cursor, then holds; the video ends on a hold, since X loops it.
const TypedUrl: React.FC<{ readonly text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const shown = Math.round(interpolate(frame, [0, 24], [0, text.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  const cursorOn = frame < 24 || Math.floor(frame / 15) % 2 === 0;
  return (
    <>
      {text.slice(0, shown)}
      <span style={{ display: "inline-block", width: "0.6em", height: "1.05em", marginLeft: 4, verticalAlign: "-0.15em", background: "#FFB547", opacity: cursorOn ? 1 : 0 }} />
    </>
  );
};

// Beat 8.
const CtaInner = () => {
  const frame = useCurrentFrame();
  return (
    <>
      <Backdrop />
      <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 44 }}>
        <Wordmark name="CTA wordmark" size={150} animate />
        <Interactive.Div
          name="CTA headline"
          style={{
            fontFamily: "Geist, sans-serif",
            fontWeight: 600,
            fontSize: 96,
            letterSpacing: "-0.03em",
            color: "#f5f5f5",
            opacity: interpolate(frame, [14, 26], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            translate: interpolate(frame, [14, 26], ["0px 24px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.spring({ damping: 200 }),
            }),
          }}
        >
          Deploy your own.
        </Interactive.Div>
        <Sequence name="Repository URL" from={26} layout="none">
          <div
            style={{
              padding: "18px 34px",
              borderRadius: 999,
              border: "1px solid rgba(255, 255, 255, 0.14)",
              background: "rgba(255, 255, 255, 0.03)",
              fontFamily: "'Geist Mono', monospace",
              fontSize: 44,
              color: "#f5f5f5",
            }}
          >
            <TypedUrl text="github.com/spiritledsoftware/t3flare" />
          </div>
        </Sequence>
      </div>
      <Interactive.Div
        name="Disclaimer"
        style={{
          position: "absolute",
          bottom: 70,
          fontFamily: "Geist, sans-serif",
          fontSize: 24,
          color: "#737373",
          opacity: interpolate(frame, [40, 55], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
        }}
      >
        Independent project. Not affiliated with T3 Tools Inc.
      </Interactive.Div>
    </>
  );
};

export const Cta = Interactive.create({ Component: CtaInner, layout: "absolute-fill" });
