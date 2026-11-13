# SPI-1061 (plan §8, D16): the stage stand-in for the owner's laptop. A stock `t3` from npm at an exact version, with
# t3's Pi provider (`pi`) on the model proxy, and `cloudflared` to run the stage's named tunnel. Its agents run in this
# container, never as the owner's user. Built and run by scripts/lib/standin.ts.
FROM cloudflare/cloudflared:latest AS cloudflared

FROM node:24-bookworm
ARG T3_VERSION
ARG PI_VERSION
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git procps ripgrep \
  && rm -rf /var/lib/apt/lists/*
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared
RUN npm install -g --no-fund --no-audit "t3@${T3_VERSION}" "@earendil-works/pi-coding-agent@${PI_VERSION}" \
  && git config --global user.name "t3flare stand-in" \
  && git config --global user.email "standin@t3flare.invalid" \
  && git config --global init.defaultBranch main \
  && mkdir -p /data /work
COPY faultproxy.mjs /usr/local/lib/faultproxy.mjs
ENV PI_CODING_AGENT_DIR=/data/pi-agent
WORKDIR /work
# t3 on 3774 (the harness's loopback port); the tunnel's origin is the relay on 3773, which passes every byte through
# unless a fault is set (C6).
EXPOSE 3773 3774
CMD ["sh", "-c", "node /usr/local/lib/faultproxy.mjs & exec t3 serve --base-dir /data --port 3774 --host 0.0.0.0 --no-browser /work"]
