import type React from "react";
import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { SANS } from "../fonts";

type Props = {
  readonly app: string;
  readonly title: string;
  readonly body: string;
  readonly bannerAt: number;
  readonly style?: React.CSSProperties;
};

// A drawn phone (we cannot record the Owner's) whose lock screen receives T3 Code's stock "finished" alert, as
// T3 Connect pushes it: the thread's title, then "Done: <project>" (t3code/infra/relay agentActivityAlerts.ts).
// The icon is a neutral glyph, never T3's logo.
const PhoneNotificationInner: React.FC<Props> = ({ app, title, body, bannerAt, style }) => {
  const frame = useCurrentFrame();
  const rise = interpolate(frame, [0, 18], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.spring({ damping: 200 }),
  });
  const drop = interpolate(frame, [bannerAt, bannerAt + 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.spring({ damping: 18, stiffness: 180 }),
  });
  const buzz = frame >= bannerAt && frame < bannerAt + 10 ? Math.sin(frame * 2.6) * 4 : 0;
  return (
    <div
      style={{
        position: "absolute",
        right: 150,
        top: 150,
        width: 400,
        height: 820,
        borderRadius: 64,
        background: "#0b0b0c",
        boxShadow: "inset 0 0 0 3px #2e2e33, 0 40px 120px rgba(0, 0, 0, 0.85)",
        translate: `${buzz}px ${rise * 1000}px`,
        overflow: "hidden",
        fontFamily: SANS,
        ...style,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 12,
          borderRadius: 54,
          background: "radial-gradient(120% 80% at 50% 0%, #2a1a10 0%, #0d0d10 55%, #050506 100%)",
        }}
      />
      <div style={{ position: "absolute", left: "50%", translate: "-50% 0", top: 26, width: 120, height: 34, borderRadius: 20, background: "#000" }} />
      <div style={{ position: "absolute", width: "100%", top: 110, textAlign: "center", color: "rgba(255,255,255,0.92)", fontSize: 92, fontWeight: 500, letterSpacing: "-0.03em" }}>
        9:41
      </div>
      <div
        style={{
          position: "absolute",
          left: 22,
          right: 22,
          top: 270,
          padding: "16px 18px",
          borderRadius: 26,
          background: "rgba(48, 48, 52, 0.92)",
          display: "flex",
          gap: 14,
          opacity: drop,
          translate: `0 ${(1 - drop) * -60}px`,
          scale: String(0.9 + drop * 0.1),
        }}
      >
        <div style={{ width: 52, height: 52, flexShrink: 0, borderRadius: 13, background: "linear-gradient(180deg, #3a3a40, #1c1c20)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12)" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 19, color: "rgba(255,255,255,0.6)" }}>
            <span>{app}</span>
            <span>now</span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 600, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
          <div style={{ fontSize: 21, color: "rgba(255,255,255,0.88)" }}>{body}</div>
        </div>
      </div>
    </div>
  );
};

export const PhoneNotification = Interactive.create({
  Component: PhoneNotificationInner,
  layout: "none",
  schema: {
    app: { type: "string", default: "T3 Code", description: "App name" },
    title: { type: "string", default: "Add Arithmetic Shell Scripts With Tests", description: "Title (the thread's)" },
    body: { type: "string", default: "Done: t3flare-fixture", description: "Body" },
    bannerAt: { type: "number", default: 24, min: 0, step: 1, description: "Banner at frame", hiddenFromList: false },
  },
});
