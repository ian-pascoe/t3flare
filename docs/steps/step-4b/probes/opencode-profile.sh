# OpenCode's profile for M0 (plan §4.2 with changelog F6): system configuration on Container-local disk, XDG homes,
# switches. Sourced by the probes; MODEL_PROXY_URL comes from run.sh. OC_MODELS is a JSON object of model entries.
set -u
OC_HOME=${OC_HOME:-/var/lib/t3flare/opencode-home}
rm -rf "$OC_HOME" && mkdir -p "$OC_HOME"/{config,data,cache,state} /etc/opencode/plugins
cp -r /probe/oc-plugin /etc/opencode/plugins/t3flare-key
OC_MODELS=${OC_MODELS:-'{"claude-sonnet-5-5":{"name":"Claude Sonnet 5.5","limit":{"context":200000,"output":64000}},"claude-haiku-5-5":{"name":"Claude Haiku 5.5","limit":{"context":200000,"output":32000}},"gpt-6-luna":{"name":"GPT-6 Luna","limit":{"context":400000,"output":128000}},"deepseek-v4-pro":{"name":"DeepSeek V4 Pro","limit":{"context":128000,"output":32000}}}'}
ASK='[{"action":"*","resource":"*","effect":"ask"},{"action":"read","resource":"*","effect":"allow"},{"action":"glob","resource":"*","effect":"allow"},{"action":"grep","resource":"*","effect":"allow"},{"action":"list","resource":"*","effect":"allow"},{"action":"question","resource":"*","effect":"allow"},{"action":"external_directory","resource":"*","effect":"ask"}]'
if [ "${OC_PROFILE_MODE:-managed}" = managed ]; then
  jq -n --arg url "${OC_BASE_URL:-$MODEL_PROXY_URL/v1}" --argjson models "$OC_MODELS" --argjson ask "$ASK" '
  { "$schema": "https://opencode.ai/config.json",
    providers: { t3flare: { name: "Model proxy", package: "@opencode/ai/providers/anthropic-compatible",
                            settings: { baseURL: $url }, models: $models } },
    model: "t3flare/claude-sonnet-5-5", small_model: "t3flare/claude-haiku-5-5",
    plugins: ["/etc/opencode/plugins/t3flare-key"],
    policies: [
      {action:"provider.use",resource:"*",effect:"deny"}, {action:"provider.use",resource:"t3flare",effect:"allow"},
      {action:"integration.connect",resource:"*",effect:"deny"},
      {action:"mcp.use",resource:"*",effect:"deny"}, {action:"skill.use",resource:"*",effect:"deny"},
      {action:"plugin.use",resource:"*",effect:"deny"}, {action:"plugin.use",resource:"/etc/opencode/plugins/t3flare-key",effect:"allow"},
      {action:"websearch.use",resource:"*",effect:"deny"},
      {action:"tool.use",resource:"subagent:*",effect:"deny"}, {action:"tool.use",resource:"subagent:general",effect:"allow"},
      {action:"tool.use",resource:"subagent:explore",effect:"allow"} ],
    permissions: $ask,
    agents: { build: {permissions: $ask}, plan: {permissions: ($ask + [{action:"edit",resource:"*",effect:"deny"}])},
              general: {permissions: $ask}, explore: {permissions: $ask} },
    update: "disable", share: "disabled", snapshots: false, lsp: false, formatter: false }' >/etc/opencode/opencode.json
else
  rm -f /etc/opencode/opencode.json
fi
export XDG_CONFIG_HOME=$OC_HOME/config XDG_DATA_HOME=$OC_HOME/data XDG_CACHE_HOME=$OC_HOME/cache \
  XDG_STATE_HOME=$OC_HOME/state HOME=/root OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 \
  OPENCODE_DISABLE_FREE_MODELS=1 OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_DISABLE_LSP_DOWNLOAD=1
