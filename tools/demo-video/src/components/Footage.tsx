import { Video } from "@remotion/media";
import { getStaticFiles } from "@remotion/studio";
import type React from "react";
import { AbsoluteFill, staticFile } from "remotion";
import { MONO, MUTED } from "../fonts";

type Props = Omit<React.ComponentProps<typeof Video>, "src"> & {
  // A clip under public/, e.g. "footage/hook-turn.mp4", made by `pnpm capture shot <shot>`.
  readonly clip: string;
};

// A recorded clip, or, until it is captured, a placeholder naming the command that records it.
export const Footage: React.FC<Props> = ({ clip, ...videoProps }) => {
  const found = getStaticFiles().some((f) => f.name === clip);
  if (found) {
    return (
      <Video
        muted
        objectFit="cover"
        {...videoProps}
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", ...videoProps.style }}
        src={staticFile(clip)}
      />
    );
  }
  const shot = clip.replace(/^footage\//, "").replace(/\.mp4$/, "");
  return (
    <AbsoluteFill
      style={{
        background: "repeating-linear-gradient(135deg, #0a0a0a 0 24px, #0e0e0e 24px 48px)",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        fontFamily: MONO,
        color: MUTED,
      }}
    >
      <div style={{ fontSize: 40, color: "#e5e5e5" }}>{shot}</div>
      <div style={{ fontSize: 24 }}>pnpm capture shot {shot}</div>
    </AbsoluteFill>
  );
};
