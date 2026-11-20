import { Audio } from "@remotion/media";
import { getStaticFiles } from "@remotion/studio";
import type React from "react";
import { interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

type Props = {
  // Seconds into the track the video starts at: set it so the track's lift lands on the lid closing, at 0:04.5.
  readonly startAt: number;
  readonly volume: number;
};

// The optional music bed: public/music.mp3, gitignored, used only when present. Without it the video is silent.
export const Music: React.FC<Props> = ({ startAt, volume }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, fps } = useVideoConfig();
  if (!getStaticFiles().some((f) => f.name === "music.mp3")) return null;
  return (
    <Audio
      name="Music track"
      src={staticFile("music.mp3")}
      trimBefore={Math.round(startAt * fps)}
      volume={interpolate(frame, [0, 15, durationInFrames - 45, durationInFrames], [0, volume, volume, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })}
    />
  );
};
