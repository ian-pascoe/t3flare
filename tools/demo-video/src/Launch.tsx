import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Sequence } from "remotion";
import { Music } from "./components/Music";
import { Wordmark } from "./components/Wordmark";
import { CliAgents } from "./scenes/CliAgents";
import { Cost } from "./scenes/Cost";
import { Cta } from "./scenes/Cta";
import { Durable } from "./scenes/Durable";
import { Hook } from "./scenes/Hook";
import { LaptopLink } from "./scenes/LaptopLink";
import { Payoff } from "./scenes/Payoff";
import { Turn } from "./scenes/Turn";

// t3flare's launch video: 40 s, 1200 frames at 30 fps. Hard cuts between the footage beats; a 10-frame fade into
// the cost card and the CTA. The music's drop lands on the lid closing (frame 135), and every cut sits on a beat of
// the track (89.2 BPM, a beat every 20.16 frames from 135): 276, 458, 619, 780, 941, and the CTA's fade ends at 1062.
export const Launch = () => {
  return (
    <>
      <TransitionSeries name="Beats">
        <TransitionSeries.Sequence name="1 Hook" durationInFrames={135}>
          <Hook name="Hook" />
        </TransitionSeries.Sequence>
        <TransitionSeries.Sequence name="2 Turn" durationInFrames={141}>
          <Turn name="Turn" />
        </TransitionSeries.Sequence>
        <TransitionSeries.Sequence name="3 Payoff" durationInFrames={182}>
          <Payoff name="Payoff" />
        </TransitionSeries.Sequence>
        <TransitionSeries.Sequence name="4 Durable" durationInFrames={161}>
          <Durable name="Durable" restartAt={47.2} noticeAt={50} doneAt={72.7} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Sequence name="5 CLI agents" durationInFrames={161}>
          <CliAgents name="CLI agents" />
        </TransitionSeries.Sequence>
        <TransitionSeries.Sequence name="6 Laptop link" durationInFrames={161}>
          <LaptopLink name="Laptop link" delegatedAt={14.9} doneAt={40.9} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 10 })} />
        <TransitionSeries.Sequence name="7 Cost" durationInFrames={131}>
          <Cost name="Cost" style={{ backgroundColor: "#000000", justifyContent: "center", alignItems: "center" }} />
        </TransitionSeries.Sequence>
        <TransitionSeries.Transition presentation={fade()} timing={linearTiming({ durationInFrames: 10 })} />
        <TransitionSeries.Sequence name="8 CTA" durationInFrames={148}>
          <Cta name="CTA" style={{ backgroundColor: "#000000", justifyContent: "center", alignItems: "center" }} />
        </TransitionSeries.Sequence>
      </TransitionSeries>
      {/* The small mark at top centre, from the payoff through the laptop link (frames 276-931). */}
      <Sequence name="Corner wordmark" from={276} durationInFrames={655} layout="none">
        <div style={{ position: "absolute", top: 34, left: 0, right: 0, display: "flex", justifyContent: "center" }}>
          <Wordmark name="Corner mark" size={34} animate={false} />
        </div>
      </Sequence>
      {/* "Trap Hype Beat" (DELOSound): its drop is at 9.43 s, so starting 4.93 s in lands it on frame 135. */}
      <Music startAt={4.93} volume={0.6} />
    </>
  );
};
