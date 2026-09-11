# dsh-kenari-plugin

English | [中文](README.md)

Connects [Kenari](https://kenari.id) to the DeepSeek Harness (dsh):

- Kenari models work as dsh session models, and the default route follows the plan attached to your key
- Web search and fetch go to Kenari first, falling back to the dsh providers when a call fails
- 21 REST capabilities registered as agent tools: catalog, account, search, OCR, images, audio, video, embeddings, rerank, moderation, billing, token counting
- New session titles carry a local-time prefix, with a configurable template you can turn off
- Settings → Kenari holds everything in one page: credential status, runtime parameters, model catalog

Every capability registers through dsh's bundle patch layer and its public seams (`ctx.web`, `ctx.settings`, `ctx.tools`). Nothing in dsh is modified.

## Requirements

| Dependency | Version | Notes |
| --- | --- | --- |
| dsh | `0.1.5-rc.1` | Installed globally, `dsh` on PATH |
| Node.js | >= 22 | Matches `engines` in `package.json` |
| pnpm | any working version | `dsh plugin` forwards to it and needs it present |

dsh subpackages have to match the main version, so pin the version when you install one. The `latest` tag on npm is not necessarily `0.1.5-rc.1`:

```sh
dsh plugin --profile web add @deepseek-ai/dsh-web-fetch-http@0.1.5-rc.1
```

## Install

`lib/` is not committed, so clone and build first. `dsh plugin add github:...` will not work on its own:

```sh
git clone https://github.com/ryan-yuan-dev/dsh-kenari-plugin.git
cd dsh-kenari-plugin
pnpm install
pnpm build

dsh plugin --profile web add "$PWD"
dsh --profile web --dump-config | grep -A3 dsh-kenari-plugin   # confirm the patch layer applied
dsh --profile web
```

The profile links to this directory, so after the first install you only rerun `pnpm build` to pick up source changes.

## Set up your key

1. Open the Kenari dashboard, go to API keys → Create key, and copy the `kn-...` value (shown once)
2. Store it in the credential layer, either way works:
   - Open **Settings → Models → Kenari** and paste it into the password field
   - Or write a `.env` file, which the credential layer can write:

```sh
# ~/.dsh/.env
KENARI_API_KEY=kn-...
```

Do not put it in `cordis.patch.yml`. The settings document stores the reference name (`KENARI_API_KEY`) only. The value never reaches logs, the UI, or config.

## Session models

Installing the plugin adds a Kenari route to Settings → Models.

### Default route

The default models come from the plan attached to your key. On load, the plugin reads `GET /v1/account/quota` for the plan name, looks up that plan's `free_cache_models` (models whose cache reads do not count against the plan), and writes them into the route. It writes once. After that the layer is yours and the plugin leaves it alone.

When the plan cannot be read, which covers a missing key, a share-page key that gets a 403, or an account without a plan, this fallback preset stands:

| Model id | Display name | Context | Max output | Notes |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | DeepSeek v4 Flash | 1M | 64K | reasoning low/high/max |
| `glm-5-3-flash` | GLM 5.3 Flash | 1M | 64K | vision, reasoning low/high/max |
| `gpt-5-6-luna` | GPT 5.6 Luna | 872k | 64K | vision + PDF, 6 reasoning levels |
| `mimo-v2-5` | MiMo v2.5 | 1.05M | 64K | vision + audio + video |

This preset happens to be the free-cache list of the Kreator and Studio plans, so accounts on those plans do not trigger a write.

Display names and output caps are both derived by the plugin, since the Kenari catalog publishes neither. A name is reconstructed from the id (the catalog carries a `name` for only 8 non-chat models). The output cap is a quarter of the context window, rounded down to 1K and capped at 64K; models without a published window get no cap field. The name is presentation only, never sent in a request, and you can change it any time.

`:free` models stay out of the route by default. To use them, filter by "free" in the picker and add them there. Note that none of the four models above is free, so **a new account with no balance hits 402 on its first session**. Add a `:free` model or top up first.

Once you edit the model list yourself, your explicit user-level array replaces the preset as a whole (that is pi-ai's semantics) and the plugin stops touching it.

### Picking models by capability and plan

The catalog lists 80 models; the route holds 4. Under **Settings → Models → Kenari → Edit → Model catalog**, "Add model" and "Get available models" are the same entry point. Either one opens the picker, because for Kenari the catalog is the source of truth and typing an id by hand only bypasses it.

The dialog, buttons, and tags are dsh's own components, so this is dsh's "select models to add" dialog with a few more filter dimensions:

- Each row shows the model id, capability tags (`image`, `audio`, `video`, `pdf`, `embedding`), and for paid models a "in plan" tag meaning some subscription plan covers it. Free models carry no such tag; the `:free` suffix on the id already says so
- Filters: `in plan`, `free`, `image`, `audio`, `video`, `pdf`, `embedding`, plus "select all visible" and "clear filters". `in plan` and `free` are mutually exclusive. `embedding` is exclusive on its own, since embedding models have no chat endpoint and mixing it with anything else returns an empty list. The remaining capability filters combine and must all match
- "Add selected" **appends** to the current entries instead of replacing them. Rows already in the route cannot be selected; that cell shows a `✓` instead

The write is immediate. The plugin cannot reach the editor's draft state, so clicking "Add selected" already writes to the settings document and there is no save step. One side effect: the model list inside that card shows the old value until you collapse and reopen Edit.

The Host computes the picker's data and serves it at `GET /api/kenari.models`, so the browser only renders. It reports the same facts as `kenari_list_models`. Both the catalog and the plan table come from public endpoints and need no key.

### Three protocol lines and the compat preset

Kenari serves three lines with different base URL shapes. Getting the shape wrong answers 405, not 404:

| pi-ai `api` | Base URL |
| --- | --- |
| `openai-completions` | `https://kenari.id/v1` |
| `openai-responses` | `https://kenari.id/v1` |
| `anthropic-messages` | `https://kenari.id` (no `/v1`) |

Copy these four compat settings when you build your own route. They live in `cordis.patch.yml`:

- `maxTokensField: max_tokens`. Kenari reads `max_tokens` only. Sending `max_completion_tokens` returns 200 and silently ignores it, so the output cap is lost
- `supportsDeveloperRole: false`, so system prompts keep the `system` role
- `supportsUsageInStreaming: true`. The last streaming frame carries `usage`, which is where `cached_tokens` accounting comes from
- `reasoningEfforts` keys must come from dsh's `off|minimal|low|medium|high|xhigh|max`. Kenari's `none` maps to `off`. A wrong key stops dsh from starting, so run `dsh --profile web --dump-config` after editing the preset

## Web search and fetch

After install, both `searchProvider` and `fetchProvider` are pinned to `kenari-fallback`: Kenari first, then `deepseek-official` and the anonymous local `http` on failure (401/402/403 and network errors included). The log records direction, reason, and elapsed time.

The `available()` contract forbids network calls, so a Kenari outage only surfaces when a call fails, and the user pays one extra round trip. To drop this layer, set `fallbackEnabled` to `false` (restart required).

## Automatic recovery on model failure

When a session model call fails on a Kenari route (`kenari` or `kenari-direct`), recovery runs without manual intervention:

1. Retry 5 times at a fixed 5 second interval. dsh's own `dsh-llm-retry` does this, leaving an `llm/retry` record in the session that the UI shows as "retrying"
2. When retries run out, switch to a model whose context window is at least as large, preferring the smallest adequate one inside the same provider before looking across providers
3. If the switch also fails, fall back to dsh's default provider and model

Only when all three fail does the turn end in an error. Retry and model switching happen inside the same step, so the task is never interrupted and the plugin does not send a "continue" message.

A switched model does not inherit the old `reasoningEffort`, since levels are defined per model and may not be legal elsewhere. The switch injects a notice message you can disable with `modelSwitchNoticeEnabled`. Picking a model yourself with `/model` clears the automatic switch.

| Field | Default | Notes |
| --- | --- | --- |
| `modelRecoveryEnabled` | `true` | Master switch |
| `modelRecoveryProviders` | `['kenari','kenari-direct']` | Routes covered; anything else is untouched |
| `modelRetryMaxRetries` | `5` | Extra retries (`kenari-direct` route) |
| `modelRetryDelayMs` | `5000` | Fixed wait before each retry |
| `modelRetryableCodes` | `EMPTY_RESPONSE` `RATE_LIMIT` `SERVER` `TIMEOUT` `TRANSPORT` | Retryable failure codes, must not be empty |
| `modelSwitchEnabled` | `true` | Turn off to retry only |
| `modelSwitchDelayMs` | `5000` | Wait before a switch or fallback |
| `modelSwitchSkipCodes` | `AUTH` `INVALID_CREDENTIAL` `MISSING_CREDENTIAL` `QUOTA` | Skips the same-provider switch and falls back directly |
| `modelSwitchNoticeEnabled` | `true` | Inject a notice on switch |

`CONTEXT_WINDOW_EXCEEDED` is deliberately not retryable. Retrying the same context on the same model can only fail again, so these errors go straight to the model switch, which is often where recovery actually works.

Two limits are worth knowing:

- **Retry timing on the `llm-pi-ai` route comes from `providers.kenari.retryPolicy` in `cordis.patch.yml`, not from the plugin config above.** dsh freezes a route's retry policy when the adapter registers, and the plugin cannot change it. The patch defaults match the table, so change both together.
- **A `TRANSPORT` failure may have completed and been billed on the server.** Retrying it can bill twice. Narrow `modelRetryableCodes` if that matters. This is separate from the no-retry-on-timeout rule for generation endpoints, which covers per-call billed REST calls.

## Session title prefix

New session titles carry a prefix like `20260911174258-`, which makes them easy to place in time from the session list. The timestamp is the time of the session's first human message, in local time. The plugin writes the prefix into the `session/title` event on the server, so Web, TUI, and headless all render the same string.

The timestamp does not come from `session.header.createdAt`. dsh reuses blank sessions, so that record may be created when you open the workspace, hours before you actually say anything. The record creation time is only the fallback for a session with no human message at all.

The prefix is part of the title text, not a separate display layer. The title event schema is fixed at `{ title, messageSeqs, source }` with no prefix field, and the UI draws the string as-is. The setting therefore controls whether a prefix is written at generation time, not whether one is hidden:

- With the switch off, new titles carry no prefix, and a title written while it was off contains no prefix in its text, including when copied or exported
- Existing sessions are never rewritten, by the switch or by the template

Every title source gets the same treatment: LLM titles, the deterministic fallback, and manual renames. When a fork inherits its parent's title, the prefix becomes the child's own start time, ignoring the inherited history.

| Field | Default | Notes |
| --- | --- | --- |
| `sessionTitlePrefixEnabled` | `true` | Write a prefix when generating a title |
| `sessionTitlePrefix` | `yyyyMMddHHmmss-` | Template. Tokens are `yyyy`, `MM`, `dd`, `HH`, `mm`, `ss` in local time; other characters pass through. No token means a literal prefix such as `kenari-` |
| `sessionTitleMaxBytes` | `96` | UTF-8 byte ceiling for prefix plus body |

Three things to keep in mind:

- `sessionTitleMaxBytes` must match `maxTitleBytes` on the `session-title` row in `cordis.patch.yml`. The plugin writes title events directly and dsh will not truncate them; the patch side makes dsh's own provider and fallback paths respect the same limit
- The template has no escaping. Substrings like `yyyy` and `MM` are always replaced. Stripping an old prefix replays the current template against the session's start time. Two rare cases leave a double prefix: the template changed between parent and fork, or the parent is no longer in the store. A literal prefix such as `fix-` can also be stripped once by mistake if the body happens to start with it
- A prefix already stored in the sidebar is a cached value. After upgrading, restart dsh and open that session and it corrects itself

## Billing and budget

Each tool call returns a cost line. When the response carries `cost_micro_idr`, that is the actual charge. For calls without it (images, video, speech) the plugin multiplies the catalog's `pricing_lines` unit price by quantity and labels the result an estimate. Non-token units round up to whole units, so a 21-character TTS call counts as one 1k-character unit.

`kenari_billing` reports per-session totals, a breakdown by tool and model, token and `cached_tokens` hit rate, remaining budget, and wallet balance. When the wallet drops below `lowBalanceAlertRp` (Rp 5,000 by default), the cost line gains a warning.

`budgetCapRp` caps per-session spending and defaults to 0, meaning no cap. Once the cap is reached, spending tools are refused with advice to switch to a free model or raise the limit. The pre-check only sees spending already recorded, so it stops new billed calls rather than guaranteeing a total.

402 `insufficient_balance`, 401, 405, and 403 all carry actionable guidance. Read the error text for the next step.

## Settings page

Settings → **Kenari**. The Host half registers the namespace `kenari`. The groups follow the order you use them:

| Group | Contents |
| --- | --- |
| Key | Status and names only: configured or missing, source, writability, and a read-only key reference name. No input here; dsh's own password field writes the value |
| Models | Models the current route can use, in three columns: model id, display name, context. Only the first 3 show by default, the rest behind "show all" |
| Session titles | Switch, prefix format, byte ceiling, not collapsed |
| Advanced (collapsed) | API base URL, timeouts, retry counts, cache lifetimes, low-balance threshold. Most people set these once |
| Restart required (collapsed) | Switches fixed when the plugin loads (whether to register search/fetch/tools, budget cap, the built-in adapter). Read-only, with booleans shown as on/off. Change the matching settings section and restart dsh |
| Balance and usage | Numbers that move with usage. The page stores no snapshot, it just gives you a question you can ask as-is |

Copy exists in Chinese and English and follows dsh's language setting. The dictionary lives in `LOCALES` in `client/index.js`, where `zh` is the source key set and `en` must cover the same keys; the `pnpm build` self-check asserts that.

The nav entry uses Kenari's own mark. dsh's shell hard-codes each section's icon by section id, and a section registration carries only `id / order / label`, so the plugin cannot add one through the seam. Instead it claims the nav row labelled Kenari and paints the icon on. The PNG is served through the plugin's own same-origin route, `GET /api/kenari.favicon`.

## Tools

| Category | Tools |
| --- | --- |
| Catalog and docs | `kenari_list_models` (free grouping, pricing, context, sunset and beta warnings; no key needed), `kenari_search_docs` (also no key) |
| Account | `kenari_balance`, `kenari_usage`, `kenari_quota` (share-page keys get 403, see below) |
| Search | `kenari_x_search` (mutually exclusive handles, ≤20, date validation) |
| Documents | `kenari_ocr` (`reuse_id` reuses free) |
| Media | `kenari_image_generate`, `kenari_image_edit`, `kenari_speech`, `kenari_transcribe`, `kenari_music`, `kenari_video_generate`, `kenari_video_extend`, `kenari_video_status`, `kenari_video_content` |
| Data | `kenari_embed`, `kenari_rerank`, `kenari_moderate` |
| Context and billing | `kenari_count_tokens` (window share and compaction hint), `kenari_billing` |

Images, audio, and video land on disk through `ctx.attachments` as image or file blocks rather than going into JSON.

The known gaps are on the model side, not in the tools. The public catalog has no music or moderation model, so `kenari_music` and `kenari_moderate` only return 400. `kenari_speech` works with `mimo-v2-5-tts`, while `kokoro-tts` and `gemini-3-1-flash-tts` return an upstream 400.

## Optional: the plugin's own LlmAdapter

The `llm-pi-ai` preset already runs Kenari as a session model. If you also want:

- pricing visible in the model picker
- session token accounting and `cached_tokens` hit rate in `kenari_billing`, which the preset route cannot see
- reasoning levels exposed exactly as the catalog reports them, `none` included

set `nativeAdapterEnabled` to `true` (restart required). Its route is named `kenari-direct` by default, distinct from the preset's `kenari`, so both can coexist. Turn the switch off to go back.

```yaml
- id: kenari
  config:
    nativeAdapterEnabled: true
    nativeProviderId: kenari-direct
```

Compared with the preset it does three things less: it does not replay thinking blocks, does not inject `file-parser` (file blocks project to explanatory text, so use `kenari_ocr` to read documents), and does not map `web_search_options`. Image input works.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| 401 `invalid api key` | The key is dead; the environment did not load (open a new terminal or restart dsh after editing `.env`); the credential reference name is wrong |
| 402 `insufficient_balance` | A paid model with a zero balance. Switch to a free model (ids ending in `:free` in `kenari_list_models`) or top up |
| 405 | Wrong base URL shape: use `https://kenari.id/v1` for `openai-completions` and `openai-responses`, `https://kenari.id` for `anthropic-messages` |
| dsh fails to start with `invalid config ... reasoningEfforts` | A `reasoningEfforts` key outside dsh's allowed set. Go back to `off..max` or drop that model from the preset |
| 403 on balance, usage, or quota | The key came from a share page. Those three tools read the key owner's account data, so they are refused. Spending tools still work |
| The Kenari card in settings is blank | The client bundle was not built, or the service name is wrong. Run `pnpm build` (it self-checks) and restart |
| The nav row still shows a gear | The image did not load. Check that the package contains `assets/kenari-favicon-128.png` (a `files` entry missing `assets` causes this) and that `GET /api/kenari.favicon` responds. The plugin keeps dsh's icon whenever the route fails |
| The model list is empty | The preset did not apply. Check for an `llm-pi-ai` section in `dsh --profile web --dump-config` |

## Optional: MCP without the plugin

Kenari ships a Streamable HTTP MCP server with 8 tools, named with the `mcp__kenari__` prefix:

```json
{
  "mcpServers": {
    "kenari": {
      "url": "https://kenari.id/mcp",
      "headers": { "Authorization": "Bearer kn-..." }
    }
  }
}
```

The trade is prefixed tool names, no cost visibility or balance warnings, and one more runtime dependency. This plugin's 21 tools and its balance pre-check are all present, so the plugin path is the better one and MCP is for a quick trial.

## Uninstall

```sh
dsh plugin --profile web remove dsh-kenari-plugin
```

Everything the plugin registers hangs off a Cordis fiber and is reclaimed on unload. No dsh package or config was changed, so nothing is left behind.

## Configuration reference

Every field and its default. Most can be edited under Settings → Kenari; the ones marked (restart) belong in the matching settings section followed by a restart.

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
| `modelRetryMaxRetries` | `5` | Extra retries |
| `modelRetryDelayMs` | `5000` | Fixed wait before each retry |
| `modelRetryableCodes` | see above | Retryable failure codes, must not be empty |
| `modelSwitchEnabled` | `true` | Whether to switch models |
| `modelSwitchDelayMs` | `5000` | Wait before a switch or fallback |
| `modelSwitchSkipCodes` | see above | Codes that skip straight to the provider fallback |
| `modelSwitchNoticeEnabled` | `true` | Inject a notice on switch |
| `sessionTitlePrefixEnabled` | `true` | Session title prefix switch |
| `sessionTitlePrefix` | `yyyyMMddHHmmss-` | Prefix template |
| `sessionTitleMaxBytes` | `96` | Byte ceiling for prefix plus body |

## Development

```sh
pnpm build                      # tsc to lib/, plus the client bundle self-check
node test/real-harness.mjs      # real dsh harness (needs a real key)
node test/llm-adapter.mjs       # local fake gateway, no network and no spend
node test/session-title.mjs     # session title prefix
node test/catalog-view.mjs      # model catalog view and picker
node test/default-route.mjs     # default route decision
node test/favicon.mjs           # favicon route
node test/billed-media.mjs      # spends real money: TTS + STT, about Rp 500 per run
KENARI_ALLOW_VIDEO=1 node test/billed-video.mjs   # spends real money: generate and download a 4s video, about Rp 1,400
```

`scripts/check-client.mjs` runs as part of `pnpm build`. It checks the client bundle's registration format, export surface, module dependency declarations, and namespace, and renders the settings card for real. The bundle is hand-written with no bundler, so these checks are its compile step.

Design and measurement notes live under `docs/` (`plans/` for designs and implementation plans, `knowledge-base/` for measured facts about the dsh and Kenari interfaces). They are written for people changing this plugin and do not affect usage.

## How this was built

The plugin was written in **ZCode**, with session models from opencode's DeepSeek V4.1 Flash and Kenari's `deepseek-v4-flash`. Building it meant reading dsh's source repeatedly and editing across files. Both models hold a long context, and Kenari's pay-as-you-go billing keeps the cost of trial and error low.

If you want a similar setup, these are the two I actually use:

- **[Kenari](https://kenari.id/code/KNR-KKRNAJ)**: One key reaches models from several vendors. The catalog lists 80, from DeepSeek, GLM and GPT through speech, image, video, OCR, embeddings and rerank. It speaks OpenAI-compatible, Anthropic-compatible and Responses, so an existing client needs only a new base URL. Billing comes both per use and as a monthly plan, in Rupiah, with a low top-up minimum (QRIS from Rp 1,000). The catalog and docs endpoints are public, so you can see what you get before paying.
- **[opencode Go](https://opencode.ai/go?ref=343F5JW4RA)**: $10 a month with quota per 5 hour window instead of per-token billing, and you can top up credit when the quota runs short. It works with any agent, which is why it runs the dsh session model here. Coding sessions make many small requests, so a flat monthly price is easier to predict.

## License

MIT. See [LICENSE](LICENSE).
