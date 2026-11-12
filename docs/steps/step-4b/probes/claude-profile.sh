# Claude Code's profile for M0 (plan §4.1 with changelog F3, F4, F5): the managed settings file on Container-local
# disk and the launch environment. Sourced by the probes; MODEL_PROXY_URL comes from run.sh.
# CLAUDE_PROFILE_MODE=defaults skips the managed file (P3's default run).
set -u
CLAUDE_HOME=${CLAUDE_HOME:-/var/lib/t3flare/claude-home}
rm -rf "$CLAUDE_HOME" && mkdir -p "$CLAUDE_HOME" /etc/claude-code
SMALL=${CLAUDE_SMALL_MODEL:-claude-haiku-5-5}
# The nonce rides in the managed helper command, not the launch environment (P1: the env scrub needs bwrap and plants
# empty decoy files in the repo, so it is off).
HELPER=${CLAUDE_KEY_HELPER:-T3FLARE_MODEL_KEY_NONCE=${CLAUDE_NONCE:-none} /opt/t3flare/bin/t3flare-model-key claude}
# Every variable a repository's settings could use to send the request (and the helper's key) elsewhere, pinned
# empty in managed env (F3). Managed env wins per variable.
PINNED_EMPTY=${CLAUDE_PINNED_EMPTY:-'["HTTPS_PROXY","HTTP_PROXY","https_proxy","http_proxy","ALL_PROXY","NO_PROXY","NODE_EXTRA_CA_CERTS","SSL_CERT_FILE","SSL_CERT_DIR","NODE_TLS_REJECT_UNAUTHORIZED","CLAUDE_CODE_CLIENT_CERT","CLAUDE_CODE_CLIENT_KEY","CLAUDE_CODE_CLIENT_KEY_PASSPHRASE","CLAUDE_CODE_USE_BEDROCK","CLAUDE_CODE_USE_VERTEX","CLAUDE_CODE_USE_FOUNDRY","CLAUDE_CODE_SKIP_BEDROCK_AUTH","CLAUDE_CODE_SKIP_VERTEX_AUTH","CLAUDE_CODE_SKIP_FOUNDRY_AUTH","ANTHROPIC_BEDROCK_BASE_URL","ANTHROPIC_VERTEX_BASE_URL","ANTHROPIC_FOUNDRY_BASE_URL","ANTHROPIC_FOUNDRY_RESOURCE","ANTHROPIC_VERTEX_PROJECT_ID","AWS_BEARER_TOKEN_BEDROCK","ANTHROPIC_CUSTOM_HEADERS","ANTHROPIC_AUTH_TOKEN","ANTHROPIC_API_KEY","CLAUDE_CODE_OAUTH_TOKEN","ANTHROPIC_UNIX_SOCKET","ANTHROPIC_MODEL","ANTHROPIC_SMALL_FAST_MODEL"]'}
if [ "${CLAUDE_PROFILE_MODE:-managed}" = managed ]; then
  jq -n --argjson models "${CLAUDE_AVAILABLE_MODELS:-[]}" --arg url "$MODEL_PROXY_URL" --arg small "$SMALL" --arg helper "$HELPER" --argjson empty "$PINNED_EMPTY" '
  { apiKeyHelper: $helper, availableModels: $models,
    allowedProviders: ["customEndpoint"],
    env: ( ($empty | map({key: ., value: ""}) | from_entries) + {
      ANTHROPIC_BASE_URL: $url, ANTHROPIC_DEFAULT_HAIKU_MODEL: $small,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
      DISABLE_UPDATES: "1", DISABLE_AUTOUPDATER: "1", DISABLE_FEEDBACK_COMMAND: "1", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1", CLAUDE_CODE_MAX_RETRIES: "1",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0" }),
    skipWebFetchPreflight: true, disableClaudeAiConnectors: true, cleanupPeriodDays: 60,
    permissions: { defaultMode: "default", disableBypassPermissionsMode: "disable", allow: [], ask: [], deny: [] },
    disableAutoMode: "disable", allowManagedPermissionRulesOnly: true, allowManagedHooksOnly: true,
    allowManagedMcpServersOnly: true, allowedMcpServers: [], strictKnownMarketplaces: [],
    disableSkillShellExecution: true, strictPluginOnlyCustomization: ["hooks", "mcp", "agents"],
    sandbox: { enabled: false } }' >/etc/claude-code/managed-settings.json
else
  # Defaults (P3): only what it takes to reach the proxy, as user settings.
  rm -f /etc/claude-code/managed-settings.json
  jq -n --arg helper "$HELPER" '{apiKeyHelper: $helper}' >"$CLAUDE_HOME/settings.json"
fi
export CLAUDE_CONFIG_DIR=$CLAUDE_HOME HOME=/root CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1 \
  CLAUDE_CODE_API_KEY_HELPER_TTL_MS=86400000 ANTHROPIC_BASE_URL="$MODEL_PROXY_URL" \
  ANTHROPIC_DEFAULT_HAIKU_MODEL="$SMALL" CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_TELEMETRY=1 \
  DISABLE_ERROR_REPORTING=1 DISABLE_UPDATES=1 CLAUDE_CODE_MAX_RETRIES=1 CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 \
  CLAUDE_CODE_EXECUTABLE=/opt/t3flare/claude/node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude
