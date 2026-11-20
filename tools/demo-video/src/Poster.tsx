import { AbsoluteFill } from "remotion";
import { Backdrop } from "./components/Backdrop";
import { Caption } from "./components/Caption";
import { Footage } from "./components/Footage";
import { Laptop } from "./components/Laptop";
import { Wordmark } from "./components/Wordmark";
import "./fonts";

// The thumbnail: the hook mid-close, its headline in full, and the wordmark. No single frame of the video has all three.
export const Poster = () => {
  return (
    <AbsoluteFill>
      <Backdrop />
      <Laptop name="Poster laptop" closeProgress={0.42} style={{ scale: "0.72", translate: "0px 40px" }}>
        <Footage name="Poster screen" clip="footage/hook-turn.mp4" trimBefore={90} />
      </Laptop>
      <Caption name="Poster headline" headline="Close the laptop." sub="Your agents keep working." freeze={200} style={{ bottom: "auto", top: 70 }} />
      <div style={{ position: "absolute", bottom: 60, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
        <Wordmark name="Poster wordmark" size={64} animate={false} />
      </div>
    </AbsoluteFill>
  );
};
