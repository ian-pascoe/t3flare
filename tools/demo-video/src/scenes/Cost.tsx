import { Easing, Interactive, interpolate, useCurrentFrame } from "remotion";
import { Backdrop } from "../components/Backdrop";
import "../fonts";

// Beat 7: docs/cost.md: light use is about the $5 Workers Paid minimum; heavy use about $35; model tokens are extra.
const CostInner = () => {
  const frame = useCurrentFrame();
  return (
    <>
      <Backdrop />
      <div style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", gap: 28 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 28 }}>
          <Interactive.Div
            name="From"
            style={{
              fontFamily: "Geist, sans-serif",
              fontWeight: 500,
              fontSize: 64,
              color: "#a3a3a3",
              opacity: interpolate(frame, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }}
          >
            From
          </Interactive.Div>
          <Interactive.Div
            name="Price"
            style={{
              fontFamily: "Geist, sans-serif",
              fontWeight: 700,
              fontSize: 280,
              lineHeight: 1,
              letterSpacing: "-0.05em",
              backgroundImage: "linear-gradient(90deg, #FF7A1A 0%, #FFB547 50%, #FF7A1A 100%)",
              backgroundSize: "200% 100%",
              backgroundPosition: `${interpolate(frame, [8, 40], [100, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}% 0`,
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
              scale: interpolate(frame, [4, 24], [0.92, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.spring({ damping: 200 }),
                output: "perceptual-scale",
              }),
              opacity: interpolate(frame, [4, 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }}
          >
            $5
          </Interactive.Div>
          <Interactive.Div
            name="Per month"
            style={{
              fontFamily: "Geist, sans-serif",
              fontWeight: 600,
              fontSize: 96,
              color: "#f5f5f5",
              opacity: interpolate(frame, [10, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }}
          >
            /mo
          </Interactive.Div>
        </div>
        <Interactive.Div
          name="On Cloudflare"
          style={{
            fontFamily: "Geist, sans-serif",
            fontWeight: 600,
            fontSize: 72,
            letterSpacing: "-0.02em",
            color: "#f5f5f5",
            opacity: interpolate(frame, [16, 28], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            translate: interpolate(frame, [16, 28], ["0px 20px", "0px 0px"], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.spring({ damping: 200 }),
            }),
          }}
        >
          on Cloudflare
        </Interactive.Div>
        <Interactive.Div
          name="Model usage"
          style={{
            fontFamily: "Geist, sans-serif",
            fontWeight: 500,
            fontSize: 44,
            color: "#a3a3a3",
            opacity: interpolate(frame, [30, 42], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}
        >
          + your model usage
        </Interactive.Div>
        <Interactive.Div
          name="Cost footnote"
          style={{
            marginTop: 30,
            fontFamily: "'Geist Mono', monospace",
            fontSize: 26,
            color: "#737373",
            opacity: interpolate(frame, [40, 52], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}
        >
          Workers Paid minimum. Heavy use ≈ $35/mo.
        </Interactive.Div>
      </div>
    </>
  );
};

export const Cost = Interactive.create({ Component: CostInner, layout: "absolute-fill" });
