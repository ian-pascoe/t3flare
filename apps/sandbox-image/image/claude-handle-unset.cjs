// SPI-1168: preloaded into claude-agent-acp (t3flare-claude-agent-acp): the model handle leaves its environment before it
// runs, so the claude it starts, and claude's Bash, hooks and helpers, never inherit it. The process's own start
// environment (/proc/<pid>/environ) keeps it for the handle helper (t3flare-claude-handle).
delete process.env.T3FLARE_MODEL_HANDLE;
