# Codex Web Search

`pi-only-tools` registers a parallel `web_search` tool that follows OpenAI Codex's standalone search contract.

## Provider requirement

The active Pi model provider must implement:

```text
POST {baseUrl}/alpha/search
```

The tool reuses the active model ID, Pi's resolved provider headers/API key, and Pi's global `fetch` dispatcher. OpenAI Codex-compatible providers can use it directly; a generic Responses-compatible gateway that does not expose `alpha/search` will return an HTTP error.

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

`mode` accepts:

- `disabled`: do not register `web_search`
- `cached`: send `external_web_access: false`
- `indexed`: send `external_web_access: "indexed"`
- `live`: send `external_web_access: true`

`contextSize` accepts `low`, `medium`, or `high`. `allowedDomains` is a global domain allowlist. `location` may contain approximate `country`, `region`, `city`, and/or `timezone` values.

## Tool profiles

`web_search` is treated as a read-only tool and is enabled by default for new Normal, Ask, and Plan profiles. Version 4 and older profile files are migrated once to version 5; after that migration, removing `web_search` from a profile remains respected.
