# The Codex profile's -c overrides under test (plan §4.3 with F4/F5), as an array CODEX_PROFILE. Sourced.
provider="{name=\"Model proxy\",base_url=\"${MODEL_PROXY_URL}/v1\",wire_api=\"responses\",requires_openai_auth=false,supports_websockets=false,request_max_retries=1,stream_max_retries=1,auth={command=\"/opt/t3flare/bin/t3flare-model-key\",args=[\"codex\"],timeout_ms=30000,refresh_interval_ms=0}}"
CODEX_PROFILE=(
  -c 'model_provider="t3flare-proxy"'
  -c "model_providers.t3flare-proxy=${provider}"
  -c 'check_for_update_on_startup=false'
  -c 'shell_environment_policy.exclude=["T3FLARE_MODEL_KEY_NONCE"]'
  ${CODEX_PROFILE_EXTRA[@]+"${CODEX_PROFILE_EXTRA[@]}"}
)
