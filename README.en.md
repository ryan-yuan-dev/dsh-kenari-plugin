# dsh-kenari-plugin

[![npm version](https://img.shields.io/npm/v/dsh-kenari-plugin.svg)](https://www.npmjs.com/package/dsh-kenari-plugin)

English | [中文](README.md)

Connects [Kenari](https://kenari.id) to the DeepSeek Harness (dsh):

- Kenari models work as dsh session models, and the default route follows the plan attached to your key
- Web search and fetch go to Kenari first, falling back to the dsh providers on failure
- 21 REST capabilities registered as agent tools: catalog, account, search, OCR, images, audio, video, embeddings, rerank, moderation, billing, token counting
- New session titles carry a local-time prefix, with a template you can change or turn off
- Settings → Kenari holds everything in one page: credential status, runtime parameters, model catalog

Every capability registers through dsh's bundle patch layer and its public seams (`ctx.web`, `ctx.settings`, `ctx.tools`). Nothing in dsh is modified.

## Requirements

You need dsh `0.1.5-rc.1` (installed globally, `dsh` on PATH), Node.js >= 22, and pnpm (`dsh plugin` forwards to it). dsh subpackages must match the main version, so pin the version when installing one; npm's `latest` is not necessarily the right one:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-web-fetch-http@0.1.5-rc.1
```

## Install

The plugin is published on [npmjs](https://www.npmjs.com/package/dsh-kenari-plugin). Install it with dsh's own plugin command:

```sh
dsh plugin --profile web add dsh-kenari-plugin
dsh --profile web --dump-config | grep -A3 dsh-kenari-plugin   # confirm the patch layer applied
dsh --profile web
```

To pin a version, append it to the name, for example `dsh-kenari-plugin@0.1.1`. To work on the plugin source, install from a clone instead: `pnpm install && pnpm build`, then `dsh plugin --profile web add "$PWD"`. The profile links to that directory, so after installing you only rerun `pnpm build` for source changes.

## Set up your key

In the Kenari dashboard, go to API keys → Create key and copy the `kn-...` value (shown once). Then either:

- Open **Settings → Models → Kenari** and paste it into the password field
- Or write a `.env` file, which the credential layer can write:

```sh
# ~/.dsh/.env
KENARI_API_KEY=kn-...
```

Do not put it in `cordis.patch.yml`. The settings document stores the reference name only, and the value never reaches logs, the UI, or config.

## Session models

Installing the plugin adds a Kenari route to Settings → Models.

### Default route

The default models come from the plan attached to your key. On load, the plugin reads `GET /v1/account/quota` for the plan name, takes that plan's `free_cache_models` (models whose cache reads do not count against the plan), and writes them into the route. It writes once, then the layer is yours.

When the plan cannot be read (no key, a share-page key that gets 403, an account without a plan), this fallback preset stands. It happens to be the free-cache list of the Kreator and Studio plans:

| Model id | Display name | Context | Max output | Notes |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | Kenari DeepSeek v4 Flash | 1M | 64K | reasoning low/high/max |
| `glm-5-3-flash` | Kenari GLM 5.3 Flash | 1M | 64K | vision, reasoning low/high/max |
| `gpt-5-6-luna` | Kenari GPT 5.6 Luna | 872k | 64K | vision + PDF, 6 reasoning levels |
| `mimo-v2-5` | Kenari MiMo v2.5 | 1.05M | 64K | vision + audio + video |

None of the four is free, so **a new account with no balance hits 402 on its first session**. Add a `:free` model or top up first. `:free` models stay out of the route by default; filter by "free" in the picker to add them.

Display names and output caps are derived by the plugin, since the catalog publishes neither. A name is reconstructed from the id (the few models whose catalog entry carries a `name` keep the vendor's wording). Names **written into the route** additionally carry a `Kenari ` prefix — dsh's model button and session header show the name alone, so without it a Kenari route is indistinguishable from an official DeepSeek model of the same name — while the plugin's own model table stays unprefixed, because that page already is the Kenari section. The output cap is a quarter of the context window, clamped to [1K, 64K]; models without a published window get no cap field. The name is presentation only; a model's identity is always its id.

Once you edit the list yourself, your config replaces the preset as a whole (pi-ai's semantics) and the plugin stops touching it.

### Picking models by capability and plan

Under **Settings → Models → Kenari → Edit → Model catalog**, "Add model" and "Get available models" are the same entry point, and either opens this picker. It uses dsh's own dialog components, with extra filter dimensions:

- Each row shows the model id and capability tags (`image` `audio` `video` `pdf` `embedding`). Paid models also carry an "in plan" tag meaning a subscription plan covers them; free models are recognisable by the `:free` suffix
- Filters are `in plan`, `free`, and the capability tags. "In plan" and "free" are mutually exclusive, and `embedding` is exclusive on its own (it has no chat endpoint, so mixing it with anything returns an empty list). The rest combine
- "Add selected" **appends** to the current entries, and rows already in the route cannot be selected

The write is immediate: the picker closes itself once it is done and those rows are already in the card behind it. Every other part of that card behaves the same way — display name, base URL, protocol, and each row's id, name, context window and max output are written as soon as you stop typing, and deleting a row or restoring the default catalog takes effect the moment you click. Which is why Cancel/Save now sit under the API key field and commit nothing but the key (they stay hidden while that field is empty). The Host computes the data and serves it at `GET /api/kenari.models`, the same facts as `kenari_list_models`, and no key is needed.

### Three protocol lines and the compat preset

Kenari serves three lines with different base URL shapes. A wrong shape answers 405, not 404:

| pi-ai `api` | Base URL |
| --- | --- |
| `openai-completions` | `https://kenari.id/v1` |
| `openai-responses` | `https://kenari.id/v1` |
| `anthropic-messages` | `https://kenari.id` (no `/v1`) |

Copy these four compat settings when you build your own route. They live in `cordis.patch.yml`:

- `maxTokensField: max_tokens`. Kenari reads `max_tokens` only; sending `max_completion_tokens` returns 200 and silently ignores it
- `supportsDeveloperRole: false`, so system prompts keep the `system` role
- `supportsUsageInStreaming: true`, since the last streaming frame carries the `usage` that `cached_tokens` accounting relies on
- `reasoningEfforts` keys must come from `off|minimal|low|medium|high|xhigh|max`. Kenari's `none` maps to `off`. A wrong key stops dsh from starting, so run `--dump-config` after editing

## Web search and fetch

Both `searchProvider` and `fetchProvider` are pinned to `kenari-fallback`: Kenari first, then `deepseek-official` and the anonymous local `http` on failure (401/402/403 and network errors included). The log records direction, reason, and elapsed time.

The `available()` contract forbids network calls, so a Kenari outage only surfaces when a call fails and the user pays one extra round trip. To drop this layer, set `fallbackEnabled` to `false` (restart required).

## Automatic recovery on model failure

A failed session model call on a Kenari route recovers on its own:

1. Retry 5 times at a fixed 5 second interval **on the same route**, with the budget counted per route
2. When retries run out, switch to a model with at least as large a window, preferring the smallest adequate one in the same provider before crossing providers
3. If that also fails, fall back to dsh's default provider and model

Only when all three fail does the turn error out. Retry and switching happen inside the same step, so the task is never interrupted and the plugin sends no "continue" message. A switched model does not inherit `reasoningEffort` (levels are per model); the switch injects a notice you can disable with `modelSwitchNoticeEnabled`, and the start of a retry sequence injects one too (during retries the UI shows a single failed attempt, so an unexplained wait is worse), which `modelRetryNoticeEnabled` disables. Picking a model yourself with `/model` clears the automatic switch.

`CONTEXT_WINDOW_EXCEEDED` is deliberately not retryable. Retrying the same context on the same model can only fail again, so it goes straight to the model switch, which is often where recovery works.

Two limits:

- **Retrying is done by the plugin's own recovery state machine; dsh's `dsh-llm-retry` is deliberately switched off on Kenari routes** (`providers.kenari.retryPolicy.maxRetries: 0` in `cordis.patch.yml`, same for the plugin's own adapter). The reason is that it **fails silently**: `agent/request-error` has no default behaviour, so a listener that does not call `next()` vetoes everything after it, and the plugin cannot observe whether a live reload reordered that chain. Measured on a live session: zero `llm/retry` events and the model switch happened on the first failure — the promised retries never ran. There is therefore exactly one source for the retry budget: `modelRetryMaxRetries` / `modelRetryDelayMs` / `modelRetryableCodes`. If you set that route's `retryPolicy` back above 0, the plugin steps aside and lets dsh own it, so the two never count the same retry twice (the three scenarios in `test/retry-repro.mjs` guard this boundary).
- **A `TRANSPORT` failure may have completed and been billed on the server**, so retrying can bill twice. Narrow `modelRetryableCodes` if that matters. This is separate from the no-retry-on-timeout rule for generation endpoints.

Field defaults are in "Configuration reference".

## Session title prefix

New session titles carry a prefix like `20260911174258-`. The timestamp is the time of the session's first human message, in local time. The plugin writes it into the `session/title` event, so Web, TUI, and headless render the same string.

The timestamp does not come from `session.header.createdAt` (that records session creation, which dsh may have done hours earlier when it reused a blank session). It is the fallback for a session with no human message at all.

The prefix is part of the title text, not a separate display layer, so the setting controls whether one is written at generation time: with it off, new titles have no prefix, and a title written while it was off contains no prefix in its text. Existing sessions are never rewritten, by the switch or the template.

Every source gets the same treatment: LLM titles, the deterministic fallback, and manual renames. When a fork inherits its parent's title, the prefix becomes the child's own start time, ignoring the inherited history.

Three things to keep in mind:

- `sessionTitleMaxBytes` must match `maxTitleBytes` on the `session-title` row in `cordis.patch.yml`. The plugin writes title events directly and dsh will not truncate them
- The template has no escaping, so substrings like `yyyy` and `MM` are always replaced, and stripping an old prefix replays the template against the session's start time. A template changed between parent and fork, or a parent no longer in the store, can leave a double prefix
- A prefix already stored in the sidebar is a cached value; restart dsh and open that session and it corrects itself

Field defaults are in "Configuration reference".

## Billing and budget

Each tool call returns a cost line: `cost_micro_idr` when the response carries it, otherwise an estimate from the catalog's `pricing_lines` multiplied by quantity for images, video, and speech. Non-token units round up to whole units (a 21-character TTS call counts as one 1k-character unit).

`kenari_billing` reports per-session totals, a breakdown by tool and model, `cached_tokens` hit rate, remaining budget, and wallet balance; below `lowBalanceAlertRp` the cost line gains a warning. `budgetCapRp` defaults to 0, meaning no cap, and spending tools are refused once it is reached. The pre-check only sees recorded spending, so it stops new billed calls rather than guaranteeing a total. 402, 401, 405, and 403 all carry actionable guidance.

## Settings page

Settings → **Kenari** (namespace `kenari`). The groups follow the order you use them:

| Group | Contents |
| --- | --- |
| Key | Status and names only (configured or missing, source, writability, a read-only reference name). No input field |
| Models | Models the current route can use: id, display name, context. Only the first 3 show by default |
| Session titles | Switch, prefix format, byte ceiling |
| Advanced (collapsed) | API base URL, timeouts, retry counts, cache lifetimes, low-balance threshold |
| Restart required (collapsed) | Switches fixed at load time (whether to register search/fetch/tools, budget cap, the built-in adapter). Read-only; edit the matching settings section and restart |
| Balance and usage | Numbers that move with usage. No stored snapshot, just a question you can ask as-is |

Copy exists in Chinese and English and follows dsh's language setting; `pnpm build` asserts the two key sets match.

## Tools

| Category | Tools |
| --- | --- |
| Catalog and docs | `kenari_list_models` (free grouping, pricing, context, sunset and beta warnings; no key needed), `kenari_search_docs` (also no key) |
| Account | `kenari_balance`, `kenari_usage`, `kenari_quota` (share-page keys get 403) |
| Search | `kenari_x_search` |
| Documents | `kenari_ocr` (`reuse_id` reuses free) |
| Media | `kenari_image_generate`, `kenari_image_edit`, `kenari_speech`, `kenari_transcribe`, `kenari_music`, `kenari_video_generate`, `kenari_video_extend`, `kenari_video_status`, `kenari_video_content` |
| Data | `kenari_embed`, `kenari_rerank`, `kenari_moderate` |
| Context and billing | `kenari_count_tokens`, `kenari_billing` |

Images, audio, and video land on disk through `ctx.attachments` as image or file blocks rather than going into JSON.

The public catalog has no music or moderation model, so `kenari_music` and `kenari_moderate` only return 400. `kenari_speech` works with `mimo-v2-5-tts`, while `kokoro-tts` and `gemini-3-1-flash-tts` return an upstream 400.

## Optional: the plugin's own LlmAdapter

The `llm-pi-ai` preset already runs Kenari as a session model. Setting `nativeAdapterEnabled` to `true` (restart required) adds pricing in the model picker, token accounting and `cached_tokens` hit rate in `kenari_billing`, and reasoning levels exposed exactly as the catalog reports them, `none` included.

Its route is named `kenari-direct` by default, distinct from the preset's `kenari`, so both coexist and turning the switch off reverts. Compared with the preset it does not replay thinking blocks, inject `file-parser` (file blocks project to explanatory text, so use `kenari_ocr` to read documents), or map `web_search_options`; image input works.

```yaml
- id: kenari
  config:
    nativeAdapterEnabled: true
    nativeProviderId: kenari-direct
```

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| 401 `invalid api key` | The key is dead; dsh was not restarted after a `.env` edit; the credential reference name is wrong |
| 402 `insufficient_balance` | A paid model with a zero balance. Switch to a `:free` model or top up |
| 405 | Wrong base URL shape, see "Three protocol lines" |
| Startup fails with `invalid config ... reasoningEfforts` | That model's `reasoningEfforts` key is outside `off..max`. Revert it or drop the model from the preset |
| 403 on balance, usage, or quota | The key came from a share page, and those tools read the key owner's account data |
| The Kenari card in settings is blank | The client bundle was not built, or the service name is wrong. Run `pnpm build` and restart |
| The nav row still shows a gear | The image did not load. Check that the package contains `assets/kenari-favicon-128.png` and that `GET /api/kenari.favicon` responds |
| The model list is empty | The preset did not apply. Check `llm-pi-ai` in `dsh --profile web --dump-config` |

## Optional: MCP without the plugin

Kenari ships a Streamable HTTP MCP server with 8 tools, named with the `mcp__kenari__` prefix:

```json
{ "mcpServers": { "kenari": { "url": "https://kenari.id/mcp", "headers": { "Authorization": "Bearer kn-..." } } } }
```

The trade is prefixed tool names, no cost visibility or balance warnings, and one more runtime dependency. MCP is for a quick trial.

## Uninstall

```sh
dsh plugin --profile web remove dsh-kenari-plugin
```

Everything the plugin registers hangs off a Cordis fiber and is reclaimed on unload; no dsh package or config was changed.

## Configuration reference

Most fields can be edited under Settings → Kenari. The ones marked (restart) belong in the matching settings section followed by a restart.

| Field | Default | Notes |
| --- | --- | --- |
| `apiKeyEnv` | `KENARI_API_KEY` | Credential reference holding the key |
| `baseURL` | `https://kenari.id` | Kenari REST base URL used by the plugin |
| `timeoutMs` | `30000` | Per-request REST timeout |
| `generationTimeoutMs` | `180000` | Per-attempt timeout for generation calls (image/audio/music/OCR) |
| `maxRetries` | `2` | REST retries for transient failures |
| `searchEnabled` | `true` | Register the search provider (restart) |
| `fetchEnabled` | `true` | Register the fetch provider (restart) |
| `fallbackEnabled` | `true` | Fall back to the dsh defaults when Kenari fails (restart) |
| `toolsEnabled` | `true` | Register the 21 tools (restart) |
| `docsCacheTtlMs` | `3600000` | Cache lifetime for `/llms-full.txt` |
| `catalogCacheTtlMs` | `3600000` | Cache lifetime for `/v1/models` |
| `modelAliases` | `{}` | Model aliases as `{ alias: 'exact-model-id' }` |
| `lowBalanceAlertRp` | `5000` | Warn below this many Rupiah, 0 disables |
| `balanceCacheTtlMs` | `300000` | Cache lifetime for the wallet balance |
| `budgetCapRp` | `0` | Per-session spend ceiling, 0 means no cap |
| `nativeAdapterEnabled` | `false` | Register the plugin's own LlmAdapter (restart) |
| `nativeProviderId` | `kenari-direct` | Route id for that adapter |
| `modelRecoveryEnabled` | `true` | Master switch for automatic recovery |
| `modelRecoveryProviders` | `['kenari','kenari-direct']` | Routes covered by recovery |
| `modelRetryMaxRetries` | `5` | Extra retries per route |
| `modelRetryDelayMs` | `5000` | Fixed wait before each retry |
| `modelRetryableCodes` | `EMPTY_RESPONSE` `RATE_LIMIT` `SERVER` `TIMEOUT` `TRANSPORT` | Retryable failure codes, must not be empty |
| `modelRetryNoticeEnabled` | `true` | Inject a notice when retrying starts |
| `modelSwitchEnabled` | `true` | Whether to switch models |
| `modelSwitchDelayMs` | `5000` | Wait before a switch or fallback |
| `modelSwitchSkipCodes` | `AUTH` `INVALID_CREDENTIAL` `MISSING_CREDENTIAL` `QUOTA` | Codes that skip straight to the provider fallback |
| `modelSwitchNoticeEnabled` | `true` | Inject a notice on switch |
| `sessionTitlePrefixEnabled` | `true` | Session title prefix switch |
| `sessionTitlePrefix` | `yyyyMMddHHmmss-` | Prefix template |
| `sessionTitleMaxBytes` | `96` | Byte ceiling for prefix plus body |

## Development

```sh
pnpm build                      # tsc to lib/, plus the client bundle self-check
node test/real-harness.mjs      # real dsh harness (needs a real key)
node test/llm-adapter.mjs       # local fake gateway, no network and no spend
# offline suites: session-title / catalog-view / default-route / favicon, one .mjs each
node test/billed-media.mjs      # spends real money: TTS + STT, about Rp 500
KENARI_ALLOW_VIDEO=1 node test/billed-video.mjs   # spends real money: 4s video, about Rp 1,400
```

`scripts/check-client.mjs` runs as part of `pnpm build`. It checks the client bundle's registration format, export surface, dependency declarations, and namespace, and renders the settings card for real (the bundle is hand-written with no bundler, so these checks are its compile step). Design and measurement notes live under `docs/`, written for people changing this plugin.

## How this was built

The plugin was written in **ZCode**, with session models from opencode's DeepSeek V4.1 Flash and Kenari's `deepseek-v4-flash`. Building it meant reading dsh's source repeatedly and editing across files, so both were picked for holding a long context.

If you want a similar setup, these are the two I actually use:

- **[Kenari](https://kenari.id/code/KNR-KKRNAJ)**: one key reaches models from several vendors, more than 70 in the catalog, from DeepSeek, GLM and GPT through speech, image, video, OCR, embeddings and rerank. It speaks OpenAI-compatible, Anthropic-compatible and Responses, so an existing client needs only a new base URL. Billing comes both per use and as a monthly plan, in Rupiah, with a low top-up minimum (QRIS from Rp 1,000). The catalog and docs endpoints are public, so you can see what you get before paying.
- **[opencode Go](https://opencode.ai/go?ref=343F5JW4RA)**: $10 a month with quota per 5 hour window instead of per-token billing, and you can top up credit when the quota runs short. It works with any agent, which is why it runs the dsh session model here.

## License

MIT. See [LICENSE](LICENSE).
