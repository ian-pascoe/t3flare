import { Composition, Folder, Still } from "remotion";
import { AppIcon, Logo } from "./Brand";
import { Launch } from "./Launch";
import { Poster } from "./Poster";
import { CliAgents } from "./scenes/CliAgents";
import { Cost } from "./scenes/Cost";
import { Cta } from "./scenes/Cta";
import { Durable } from "./scenes/Durable";
import { Hook } from "./scenes/Hook";
import { RemoteTask } from "./scenes/RemoteTask";
import { Payoff } from "./scenes/Payoff";
import { Turn } from "./scenes/Turn";

export const RemotionRoot = () => {
  return (
    <>
      <Composition id="Launch" component={Launch} durationInFrames={1200} fps={30} width={1920} height={1080} />
      <Still id="Poster" component={Poster} width={1920} height={1080} />
      <Folder name="Brand">
        <Still id="LogoOnDark" component={Logo} width={1200} height={360} defaultProps={{ ink: "#f5f5f5" }} />
        <Still id="LogoOnLight" component={Logo} width={1200} height={360} defaultProps={{ ink: "#0a0a0a" }} />
        <Still id="AppIcon" component={AppIcon} width={1024} height={1024} />
      </Folder>
      <Folder name="Scenes">
        <Composition id="Hook" component={Hook} durationInFrames={135} fps={30} width={1920} height={1080} defaultProps={{}} />
        <Composition id="Turn" component={Turn} durationInFrames={141} fps={30} width={1920} height={1080} defaultProps={{}} />
        <Composition id="Payoff" component={Payoff} durationInFrames={182} fps={30} width={1920} height={1080} defaultProps={{}} />
        <Composition id="Durable" component={Durable} durationInFrames={161} fps={30} width={1920} height={1080} defaultProps={{ restartAt: 47.2, noticeAt: 50, doneAt: 72.7 }} />
        <Composition id="CliAgents" component={CliAgents} durationInFrames={161} fps={30} width={1920} height={1080} defaultProps={{}} />
        <Composition id="RemoteTask" component={RemoteTask} durationInFrames={161} fps={30} width={1920} height={1080} defaultProps={{ delegatedAt: 14.9, doneAt: 40.9 }} />
        <Composition
          id="Cost"
          component={Cost}
          durationInFrames={131}
          fps={30}
          width={1920}
          height={1080}
          defaultProps={{ style: { backgroundColor: "#000000", justifyContent: "center", alignItems: "center" } }}
        />
        <Composition
          id="Cta"
          component={Cta}
          durationInFrames={148}
          fps={30}
          width={1920}
          height={1080}
          defaultProps={{ style: { backgroundColor: "#000000", justifyContent: "center", alignItems: "center" } }}
        />
      </Folder>
    </>
  );
};
