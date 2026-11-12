# Codex Web Search

`pi-only-tools` registers a parallel `web_search` tool that follows OpenAI Codex's standalone search contract.

## Provider requirement

The selected Pi model provider must implement:

```text
POST {baseUrl}/alpha/search
```

By default, the tool uses the active model. Set both `provider` and `model` in the search configuration to use a dedicated model registered in Pi. The request uses that model's ID and base URL, Pi's resolved credentials and headers for that model, and Pi's global `fetch` dispatcher. Changing the chat model then leaves the configured search route unchanged.

A Codex-compatible provider exposing this endpoint can serve search requests. Responses API compatibility alone does not imply search support. HTTP 404, 405, and 501 responses produce a specific endpoint-unavailable error with a configuration hint; no separate probe request is sent.

## Supported commands

The schema supports `search_query`, `image_query`, `open`, `click`, `find`, PDF `screenshot`, `finance`, `weather`, `sports`, `time`, and `response_length`. Empty command arrays and unknown display-only fields are removed before the request is sent.

The tool can include the latest two user turns plus a bounded assistant-text tail as search context. Search output is returned to the model, while the TUI shows only one compact activity row. Internal Codex citation/reference markers are therefore not printed as raw terminal text.

## Configuration

Packaged defaults live in `src/web-search/config.json`:

```json
{
  "mode": "live",
  "contextSize": "medium",
  "allowedDomains": [],
  "maxOutputTokens": 8000,
  "timeoutMs": 60000,
  "includeRecentContext": true
}
```

A user override can be placed at `~/.pi/agent/web-search.json` (or the directory selected by `PI_CODING_AGENT_DIR`). Set `PI_ONLY_TOOLS_WEB_SEARCH_CONFIG` to use another file. Override fields are merged over the packaged defaults and take effect after `/reload`.

To separate search from the chat model, add a pair of registered Pi identifiers:

```json
{
  "provider": "your-search-provider",
  "model": "your-search-model",
  "mode": "live"
}
```

Replace both example identifiers with a provider/model pair already registered in Pi and backed by a working `/alpha/search` endpoint. Both fields are required when either is set. An unknown model fails before credentials are resolved or any HTTP request is sent. Omit both fields to inherit the current model; credentials remain managed by Pi, not by this configuration file.

`mode` accepts:

- `disabled`: do not register `web_search`
- `cached`: send `external_web_access: false`
- `indexed`: send `external_web_access: "indexed"`
- `live`: send `external_web_access: true`

`contextSize` accepts `low`, `medium`, or `high`. `allowedDomains` is a global domain allowlist. `location` may contain approximate `country`, `region`, `city`, and/or `timezone` values.

## Tool profiles

`web_search` is treated as a read-only tool and is enabled by default for new Normal, Ask, and Plan profiles. Profile schema 6 migrates supported older files, adding `web_search` once where needed and `bash` once to Ask/Plan. Once migrated, later user removals remain respected. Damaged files and unknown schema versions are preserved without automatic recovery to broader default permissions.
