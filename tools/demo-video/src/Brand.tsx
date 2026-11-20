import { AbsoluteFill } from "remotion";
import { Spark } from "./components/Spark";
import { Wordmark } from "./components/Wordmark";
import "./fonts";

// t3flare's brand marks, rendered by `pnpm brand` into docs/assets/ for the README and the GitHub App's logo.

/** The wordmark on a transparent background, "t3" in `ink`: light for dark themes, dark for light ones. */
export const Logo = ({ ink }: { readonly ink: string }) => (
  <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
    <Wordmark name="Logo" size={200} animate={false} ink={ink} style={{ translate: "-24px 18px" }} />
  </AbsoluteFill>
);

/** The square icon: the flare on black with a warm glow. GitHub shows an app's logo in a rounded square. */
export const AppIcon = () => (
  <AbsoluteFill
    style={{
      justifyContent: "center",
      alignItems: "center",
      background: "radial-gradient(60% 60% at 50% 50%, rgba(255, 122, 26, 0.28) 0%, rgba(0, 0, 0, 0) 70%), #000",
    }}
  >
    <Spark size={380} style={{ filter: "drop-shadow(0 0 70px rgba(255, 140, 40, 0.75))" }} />
  </AbsoluteFill>
);
