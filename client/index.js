/**
 * Kenari settings section — browser half.
 *
 * This file is checked in already wrapped in the client module loader's
 * factory format instead of being produced by a bundler: this package builds
 * with plain `tsc`, and the loader only requires that
 * `exports["./client"]` be a file that calls `window.__ModuleLoader__.load`.
 * `scripts/check-client.mjs` runs on every build and executes this factory
 * against a stub module table, so a change that breaks the format, the module
 * requests, or a render path fails the build rather than the browser.
 *
 * Modules come from dsh's frozen platform table only: `react` plus
 * `@deepseek-ai/dsh-client-ui-primitives` (the shell seeds both, so neither
 * needs a `dsh.client.external` declaration). Using dsh's own primitives is
 * what lets the picker below BE the Models page's dialog — same Modal chrome,
 * same Button/Pill/Tag tokens — rather than a look-alike beside it.
 *
 * What deliberately is NOT here: wallet balance, spend totals, and live
 * catalog prices. Those live behind the Host on endpoints with no Remote
 * namespace, and this plugin does not add one — inventing a new Host API
 * package would mean touching dsh beyond a bundle. The card therefore points
 * at the tools that do have them (`kenari_billing`, `kenari_balance`,
 * `kenari_list_models`) instead of showing a number it cannot refresh.
 *
 * The catalog itself (capability tags, plan coverage, every filter's facts)
 * is computed Host-side and read through the plugin's own same-origin Fetch
 * route: dsh's Connection service lets a Host plugin register `/api/...`
 * routes, so the browser reads `/api/kenari.models` with the same session that
 * already authenticates the Remote calls. The browser never parses Kenari's
 * payloads itself, so the tags here and `kenari_list_models` cannot disagree.
 *
 * Entry points: the Kenari card's 模型目录 section renders two buttons that both
 * mean "put a model in this route" — 添加模型 (native: append a blank row to type
 * into) and 获取可用模型 (native: ask the provider what it has). For Kenari the
 * catalog IS the source of truth, so both open this plugin's picker instead of
 * two divergent native paths. dsh renders those buttons itself and offers no
 * slot inside its dialog — adding fields there would mean editing dsh, which
 * this plugin never does. What a plugin CAN own is the entry point, so
 * `installEntryTakeover` recognizes those two labels in the card this bundle's
 * slot renders into. Every branch fails open, so the native flow is still there
 * wherever the takeover does not apply.
 */

window.__ModuleLoader__.load({
  id: 'dsh-kenari-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { Modal, Button, Tag, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Must match the Host-side `KENARI_SETTINGS_NAMESPACE`. */
    const NS = 'kenari'

    /** Must match the Host-side `KENARI_MODEL_VIEW_PATH` (the Connection Fetch route). */
    const MODEL_VIEW_PATH = '/api/kenari.models'

    /** The pi-ai settings namespace that owns the Kenari route on the Models page. */
    const PI_AI_NS = 'llm-pi-ai'

    /**
     * Capability filter dimensions. The Host view carries the same list in
     * `tags`, which is authoritative — this is only the fallback used before
     * the first response arrives.
     */
    const CAPABILITY_TAGS = ['image', 'audio', 'video', 'pdf', 'embedding']

    /**
     * This bundle's own copy, in the two locales dsh ships.
     *
     * `zh` is the key-set source of truth and `en` must cover every key — dsh's
     * own convention, and the build gate asserts it. Nothing user-visible is
     * inlined in a component: a locale switch re-renders every slot outlet (the
     * renderer subscribes each one to the locale revision), so a stray literal
     * would be the one string that never follows the switch.
     *
     * Wording rules this copy follows, matching dsh's own settings pages: short
     * noun phrases for headings, full sentences for explanations, no jargon a
     * user would have to look up — no config-file keys, no schema terms, no
     * "Host endpoint"/"namespace" talk. Someone who only wants Kenari as a model
     * provider should be able to read every line here.
     */
    const LOCALES = {
      zh: {
        nav: 'Kenari',
        'page.title': 'Kenari',
        'page.lead': '把 kenari.id 接成 dsh 的会话模型、网页搜索与抓取，以及一组 REST 工具。',

        'connection.title': '密钥',
        'connection.keyStatus': '密钥状态',
        'connection.notice': '密钥本身在「模型」页的 Kenari 卡片里填。这里只显示它的状态和它存的名字，不会显示密钥本身。',
        'connection.status.loading': '正在读取设置…',
        'connection.status.unavailable': '当前部署的设置不可保存，改动只能在配置文件里做。',

        'key.configured': '已配置',
        'key.missing': '未配置',
        'key.source': '来源 {source}',
        'key.editable': '可修改',
        'key.locked': '由启动环境提供，不可改',
        'key.checking': '查询中…',
        'key.checkFailed': '状态查询失败：{message}',
        'key.missingRef': '没有这个引用',

        'models.title': '模型',
        'models.loading': '正在读取模型…',
        'models.error': '模型列表读取失败：{message}',
        'models.empty': '这个路由还没有模型。可以到「模型」页的 Kenari 卡片里添加，或重启 dsh 让内置模型生效。',
        'models.summary': '路由 {route} 提供 {count} 个模型。',
        'models.expandAll': '展开全部 {count} 个',
        'models.routeEmpty': '空目录',
        'models.noRoute': '没有可用的 Kenari 模型路由（{failures}）',
        'ui.expand': '展开',
        'ui.collapse': '收起',
        'models.hint': '这里列出当前路由可用的模型。价格和完整目录（含向量、重排这类非会话模型）要看的话，在对话里问一句就行，比如「列出 Kenari 的模型和价格」。',
        'models.colId': '模型 ID',
        'models.colName': '显示名称',
        'models.colContext': '上下文',

        'sessionTitle.title': '会话标题',
        'sessionTitle.prefix': '新会话标题加时间前缀',
        'sessionTitle.prefix.hint': '开启后新会话的标题会带上创建时间，方便按时间排序；已有会话不受影响。',

        'advanced.title': '高级设置',
        'advanced.hint': '这些参数多数只需要设置一次，改完下一次操作即生效。',

        'field.baseURL': 'API 地址',
        'field.baseURL.hint': '插件调用 Kenari API 用的地址，默认 https://kenari.id；写成 …/v1 也可以，插件自己归一。会话模型用的是「模型」页那张卡里的地址，两者互不影响。',
        'field.apiKeyEnv': '密钥引用名',
        'field.apiKeyEnv.hint': '密钥保存在这个名字下，与「模型」页那张卡是同一个。改它会让会话模型和工具指向不同的密钥，所以这里只读。',
        'field.timeoutMs': '请求超时（毫秒）',
        'field.generationTimeoutMs': '生成类超时（毫秒）',
        'field.generationTimeoutMs.hint': '图像、语音、OCR 这类按次计费的调用。超时不会自动重试，避免重复扣费。',
        'field.maxRetries': '失败重试次数',
        'field.maxRetries.hint': '只对限流、超时和网络错误生效。',
        'field.catalogCacheTtlMs': '模型目录缓存（毫秒）',
        'field.docsCacheTtlMs': '文档缓存（毫秒）',
        'field.balanceCacheTtlMs': '余额缓存（毫秒）',
        'field.lowBalanceAlertRp': '余额提醒阈值（Rp）',
        'field.lowBalanceAlertRp.hint': '余额低于这个数时，每次花费后会提醒一次；填 0 关闭。',
        'field.sessionTitlePrefix': '前缀格式',
        'field.sessionTitlePrefix.hint': '默认 yyyyMMddHHmmss-。yyyy 年、MM 月、dd 日、HH 时、mm 分、ss 秒，其余字符原样保留。',
        'field.sessionTitleMaxBytes': '标题长度上限（字节）',
        'field.sessionTitleMaxBytes.hint': '前缀加正文的总长度，超出会被截断，默认 96。',
        'field.overridden': '已自定义',
        'field.saved': '已保存',
        'field.invalidNumber': '请填数字',
        'field.on': '已开启',
        'field.off': '已关闭',

        'restart.title': '重启后生效',
        'restart.hint': '这些开关在插件加载时决定，改完要重启 dsh 才会生效。它们保存在设置里，可以用右上角的「打开配置文件」编辑。',
        'restart.search': '网页搜索',
        'restart.fetch': '网页抓取',
        'restart.fallback': '搜索或抓取失败时改用 dsh 自带方式',
        'restart.tools': 'REST 工具',
        'restart.budget': '会话预算封顶（Rp）',
        'restart.budget.hint': '填 0 表示不封顶。',
        'restart.nativeAdapter': '使用插件自带的模型适配器',
        'restart.nativeProviderId': '适配器的路由名',

        'usage.title': '余额与用量',
        'usage.hint': '这些数字随用量变化，所以这里不显示会过期的快照。在对话里问一句，dsh 会替你查最新值：',
        'usage.what': '想看什么',
        'usage.ask': '在对话里这么问',
        'usage.balance': '账户余额与近期用量',
        'usage.balance.ask': '我的 Kenari 余额还剩多少？',
        'usage.billing': '本次会话的花费与预算',
        'usage.billing.ask': '这个会话花了多少钱，还在预算内吗？',
        'usage.catalog': '模型目录、上下文长度与实时价格',
        'usage.catalog.ask': '列出 Kenari 支持图片的模型和它们的价格',
        'usage.tokens': '输入 token 与窗口占用',
        'usage.tokens.ask': '这个会话的上下文用了多少？',

        'catalog.title': '选择要添加的模型',
        'catalog.description': '按能力与套餐筛选，勾选后加入 kenari 路由。',
        'catalog.close': '关闭',
        'catalog.cancel': '取消',
        'catalog.searchPlaceholder': '搜索 id / 名称',
        'catalog.searchLabel': '搜索模型',
        'catalog.clear': '清除筛选',
        'catalog.selectAll': '全选可见',
        'catalog.clearAll': '取消全选',
        'catalog.loading': '正在读取模型目录…',
        'catalog.error': '模型目录读取失败：{message}',
        'catalog.fallback': '改用 dsh 自带对话框',
        'catalog.readonly': '设置只读，不能写入。',
        'catalog.settingsReadOnly': '设置只读，改动只能在配置文件里做。',
        'catalog.noNamespace': '设置里没有 {ns} 这一节，先让插件把预设写进去。',
        'catalog.writeRefused': '写入被拒绝，{count} 个模型没进设置。多半是设置刚被别处改过，重新打开面板再试一次。',
        'catalog.plansError': '套餐表读取失败，「套餐内」标签与筛选这次不可用：{message}',
        'catalog.empty': '当前筛选下没有模型。',
        'catalog.summary': '显示 {visible} / {total} 个，待加入 {addable} 个。「套餐内」表示这个付费模型由订阅套餐覆盖，否则走余额。',
        'catalog.footerNote': '加入后立即生效',
        'catalog.submit': '添加所选（{count}）',
        'catalog.saving': '正在加入…',
        'catalog.added': '已加入 {count} 个模型，编辑卡片已刷新。',
        'catalog.addedStale': '已加入 {count} 个模型。模型页的列表要重新展开「编辑」才会刷新。',
        'catalog.chatOnly': '（不支持会话）',
        'catalog.inRoute': '已在路由',

        'filter.plan': '套餐内',
        'filter.free': '免费',
        'tag.image': '图片',
        'tag.audio': '音频',
        'tag.video': '视频',
        'tag.pdf': 'PDF',
        'tag.embedding': '向量',
      },
      en: {
        nav: 'Kenari',
        'page.title': 'Kenari',
        'page.lead': 'Kenari (kenari.id) as a session model provider, a web search and fetch backend, and a set of REST tools.',

        'connection.title': 'API key',
        'connection.keyStatus': 'Key status',
        'connection.notice': 'The key itself is entered on the Models page, in the Kenari card. This panel only reports its state and the name it is stored under, never the key itself.',
        'connection.status.loading': 'Reading settings…',
        'connection.status.unavailable': 'Settings cannot be saved in this deployment; edit the configuration file instead.',

        'key.configured': 'Configured',
        'key.missing': 'Missing',
        'key.source': 'From {source}',
        'key.editable': 'Editable',
        'key.locked': 'Provided by the launch environment, cannot be changed',
        'key.checking': 'Checking…',
        'key.checkFailed': 'Could not read the key status: {message}',
        'key.missingRef': 'No such reference',

        'models.title': 'Models',
        'models.loading': 'Reading models…',
        'models.error': 'Could not read the model list: {message}',
        'models.empty': 'This route has no models yet. Add some on the Models page under the Kenari card, or restart dsh to load the built-in ones.',
        'models.summary': 'Route {route} offers {count} models.',
        'models.expandAll': 'Show all {count}',
        'models.routeEmpty': 'empty catalog',
        'models.noRoute': 'No usable Kenari model route ({failures})',
        'ui.expand': 'Show',
        'ui.collapse': 'Hide',
        'models.hint': 'These are the models this route can use right now. To see pricing and the full catalog — including embedding and rerank models — ask in the chat, for example "list the Kenari models and their prices".',
        'models.colId': 'Model ID',
        'models.colName': 'Display name',
        'models.colContext': 'Context',

        'sessionTitle.title': 'Session titles',
        'sessionTitle.prefix': 'Prefix new session titles with the time',
        'sessionTitle.prefix.hint': 'New sessions get their creation time in the title, which keeps them sorted by time. Existing sessions are left alone.',

        'advanced.title': 'Advanced',
        'advanced.hint': 'Most of these are set once. Changes apply to the next operation.',

        'field.baseURL': 'API address',
        'field.baseURL.hint': 'The address the plugin calls for Kenari API requests. https://kenari.id by default; a trailing /v1 is accepted and normalized. Session models use the address on the Models page card instead — the two are independent.',
        'field.apiKeyEnv': 'Key reference',
        'field.apiKeyEnv.hint': 'The name the key is stored under, the same one the Models page card uses. Changing it would point the session models and the tools at different keys, so it is read-only here.',
        'field.timeoutMs': 'Request timeout (ms)',
        'field.generationTimeoutMs': 'Generation timeout (ms)',
        'field.generationTimeoutMs.hint': 'For per-call billed work such as images, speech and OCR. A timeout is never retried, so a slow call cannot be paid for twice.',
        'field.maxRetries': 'Retries on failure',
        'field.maxRetries.hint': 'Applies to rate limits, timeouts and network errors only.',
        'field.catalogCacheTtlMs': 'Model catalog cache (ms)',
        'field.docsCacheTtlMs': 'Documentation cache (ms)',
        'field.balanceCacheTtlMs': 'Balance cache (ms)',
        'field.lowBalanceAlertRp': 'Low balance alert (Rp)',
        'field.lowBalanceAlertRp.hint': 'After a billed call, warn once when the balance falls below this. Set 0 to turn the warning off.',
        'field.sessionTitlePrefix': 'Prefix format',
        'field.sessionTitlePrefix.hint': 'yyyyMMddHHmmss- by default. yyyy year, MM month, dd day, HH hour, mm minute, ss second; anything else is kept as typed.',
        'field.sessionTitleMaxBytes': 'Title length cap (bytes)',
        'field.sessionTitleMaxBytes.hint': 'Prefix plus title, in bytes. Anything longer is truncated. 96 by default.',
        'field.overridden': 'Customized',
        'field.saved': 'Saved',
        'field.invalidNumber': 'Enter a number',
        'field.on': 'On',
        'field.off': 'Off',

        'restart.title': 'Applies after a restart',
        'restart.hint': 'These switches are decided when the plugin loads, so changing them needs a dsh restart. They live in your settings, editable through "Open configuration file" at the top right.',
        'restart.search': 'Web search',
        'restart.fetch': 'Web fetch',
        'restart.fallback': 'Fall back to the built-in way when search or fetch fails',
        'restart.tools': 'REST tools',
        'restart.budget': 'Session budget cap (Rp)',
        'restart.budget.hint': 'Set 0 for no cap.',
        'restart.nativeAdapter': 'Use the bundled model adapter',
        'restart.nativeProviderId': 'Adapter route name',

        'usage.title': 'Balance and usage',
        'usage.hint': 'These numbers move with usage, so no snapshot is shown here that would go stale. Ask in the chat and dsh looks up the current value:',
        'usage.what': 'What you want',
        'usage.ask': 'Ask in the chat',
        'usage.balance': 'Account balance and recent usage',
        'usage.balance.ask': 'How much Kenari balance do I have left?',
        'usage.billing': 'Spend and budget for this session',
        'usage.billing.ask': 'How much has this session cost, and am I still within budget?',
        'usage.catalog': 'Model catalog, context lengths and live pricing',
        'usage.catalog.ask': 'List the Kenari models that take images, with their prices',
        'usage.tokens': 'Input tokens and context usage',
        'usage.tokens.ask': 'How much of my context window is this session using?',

        'catalog.title': 'Choose models to add',
        'catalog.description': 'Filter by capability and plan, then pick the ones to write into the kenari route.',
        'catalog.close': 'Close',
        'catalog.cancel': 'Cancel',
        'catalog.searchPlaceholder': 'Search id or name',
        'catalog.searchLabel': 'Search models',
        'catalog.clear': 'Clear filters',
        'catalog.selectAll': 'Select all shown',
        'catalog.clearAll': 'Clear selection',
        'catalog.loading': 'Reading the model catalog…',
        'catalog.error': 'Could not read the model catalog: {message}',
        'catalog.fallback': 'Use the built-in dialog instead',
        'catalog.readonly': 'Settings are read-only; nothing can be written.',
        'catalog.settingsReadOnly': 'Settings are read-only; changes have to go in the configuration file.',
        'catalog.noNamespace': 'Your settings have no {ns} section yet. Let the plugin write its preset first.',
        'catalog.writeRefused': 'The write was refused and {count} models did not reach your settings. Usually the document changed elsewhere; reopen the panel and try again.',
        'catalog.plansError': 'Could not read the plan table, so the "In plan" tag and filter are unavailable this time: {message}',
        'catalog.empty': 'No model matches these filters.',
        'catalog.summary': 'Showing {visible} of {total}, {addable} ready to add. "In plan" means a subscription covers this paid model; otherwise it is billed to your balance.',
        'catalog.footerNote': 'Applies immediately',
        'catalog.submit': 'Add selected ({count})',
        'catalog.saving': 'Adding…',
        'catalog.added': 'Added {count} models; the editor card was refreshed.',
        'catalog.addedStale': 'Added {count} models. The list on the Models page refreshes once you reopen Edit.',
        'catalog.chatOnly': '(not a chat model)',
        'catalog.inRoute': 'Already in the route',

        'filter.plan': 'In plan',
        'filter.free': 'Free',
        'tag.image': 'image',
        'tag.audio': 'audio',
        'tag.video': 'video',
        'tag.pdf': 'PDF',
        'tag.embedding': 'embedding',
      },
    }

    /**
     * The translator, bound once per activation.
     *
     * Bound from the locale service rather than taken from props: `bind` returns
     * an identity-stable function that reads the active locale at call time, so
     * this bundle never has to thread `t` through six components. The outlets
     * re-render on every locale switch (the renderer subscribes each one to the
     * locale revision), and that re-render is what re-reads these strings.
     */
    let t = (key) => key

    /**
     * Marks the Kenari card in the DOM. The Models-page component renders it
     * into the same card element dsh renders that card's editor into, which is
     * what lets the click takeover tell "the 模型目录 buttons on the Kenari
     * card" from the identical buttons every other provider's editor renders.
     */
    const MARKER_ATTR = 'data-kenari-model-picker'

    /**
     * The labels of the two buttons in that card's 模型目录 section, in the
     * locales this build ships. Text is the only stable identity those buttons
     * have: their class is a CSS-module hash, and their position among their
     * siblings varies with whether the 重置模型目录 link is rendered beside
     * them. 添加模型 appends a blank row natively and 获取可用模型 fetches;
     * both are taken over because for Kenari the catalog decides what exists.
     */
    const TAKEOVER_LABELS = ['添加模型', 'Add model', '获取可用模型', 'Fetch available models']

    /**
     * The row's own editing toggle, in the locales this build ships.
     *
     * Clicking it is `setEditing(open ? undefined : target)`, and the card itself
     * renders as `open ? <ProviderEditor/> : null` — so collapse unmounts the card
     * and expand mounts a fresh one. Same identity problem as {@link TAKEOVER_LABELS}:
     * the class is a hash and the button carries the same 编辑/Edit text in both
     * locales, so text is what there is to match.
     */
    const EDIT_LABELS = ['编辑', 'Edit']

    /**
     * The card's footer pair. `apply` is dsh's own word for it — the English face
     * says Apply, not Save — and it is these two that {@link parkFooterUnderKey}
     * relocates and that this bundle takes over the submit half of.
     */
    const SUBMIT_LABELS = ['保存', 'Apply']
    const CANCEL_LABELS = ['取消', 'Cancel']

    /** The link that sends the route back to the shipped catalog. */
    const RESET_LABELS = ['恢复默认模型', 'Restore defaults']

    /**
     * The prefix of each row's model-id field, in the locales this build ships
     * (`ModelListEditor` labels them `${modelId} ${index + 1}`). Reading those
     * fields back is how the remount below proves the card it re-seeded really
     * carries the models that were just written.
     */
    const MODEL_ID_LABELS = ['模型 ID', 'Model ID']

    /**
     * dsh's per-row removal button, in the locales this build ships.
     *
     * Unlike every other label this bundle matches, this one has NO text: the
     * button is an icon, so its aria-label (`${removeModel} ${index + 1}`) is the
     * only identity it has.
     */
    const REMOVE_LABELS = ['删除模型', 'Delete model']

    /** The route this plugin owns, as the Models page and the marker seat name it. */
    const KENARI_PROVIDER = 'kenari'

    /**
     * The route's own fields, matched by their exact aria-labels (the model rows
     * use the same words with a row number appended, so only an exact match is the
     * card-level field). `path` is the key inside the route's settings profile.
     */
    const CARD_FIELDS = [
      { labels: ['显示名称', 'Display name'], path: 'displayName' },
      { labels: ['API 地址', 'Base URL'], path: 'baseURL' },
      { labels: ['API 协议', 'API protocol'], path: 'api' },
    ]

    /**
     * The per-row fields, matched by `${label} ${rowNumber}`. `model` is the key
     * inside one entry of the route's `models` array, and `capacity` marks the two
     * magnitudes, which are edited as K/M text rather than as a number.
     */
    const ROW_FIELDS = [
      { labels: ['模型 ID', 'Model ID'], model: 'id' },
      { labels: ['显示名称', 'Display name'], model: 'name' },
      { labels: ['上下文窗口', 'Context window'], model: 'contextWindow', capacity: true },
      { labels: ['最大输出 token', 'Max output tokens'], model: 'maxTokens', capacity: true },
    ]

    /** The value a field is set to when the user empties it: the key leaves the profile. */
    const UNSET = Symbol('unset')

    /** The credential reference a key typed into a route with none stored lands under. */
    const DEFAULT_KEY_REF = 'KENARI_API_KEY'

    /**
     * What an aria-label names in the Kenari card, or null when it is not a field
     * this bundle writes.
     *
     * Card fields are matched exactly and rows by `label + row number`: dsh labels
     * a row's field with the row index it renders in, which is the index this
     * bundle's writes use too.
     * @param label - the input's aria-label.
     * @returns the target, or null.
     */
    function fieldTargetOf(label) {
      if (typeof label !== 'string' || label.length === 0) return null
      for (let at = 0; at < CARD_FIELDS.length; at += 1) {
        const field = CARD_FIELDS[at]
        if (field.labels.indexOf(label) !== -1) return { where: 'card', path: field.path }
      }
      // Longest label first: 显示名称 is a prefix of nothing, but 模型 ID must not
      // claim a row whose label merely starts with it (there is none today, and
      // the trailing-number test makes that structural rather than incidental).
      for (let index = 0; index < ROW_FIELDS.length; index += 1) {
        const field = ROW_FIELDS[index]
        for (let at = 0; at < field.labels.length; at += 1) {
          const prefix = `${field.labels[at]} `
          if (label.indexOf(prefix) !== 0) continue
          const number = label.slice(prefix.length)
          if (!/^[0-9]+$/.test(number)) continue
          const row = Number(number)
          if (row < 1) continue
          return { where: 'row', model: field.model, index: row - 1, capacity: field.capacity === true }
        }
      }
      return null
    }

    /**
     * A capacity field's text as the number to store, or undefined when it is not
     * a count this card can mean.
     *
     * dsh spells these as K/M text and counts K as 1000 (its own hint says 256K is
     * 256000), so the same vocabulary is parsed here rather than a second one
     * invented. An unreadable value is left alone: the card keeps showing what the
     * user typed, and — since dsh's own 保存 no longer runs on this card — nothing
     * silently stores a NaN.
     * @param text - the field's current text.
     * @returns the count, or undefined.
     */
    function capacityOf(text) {
      if (typeof text !== 'string') return undefined
      const trimmed = text.trim()
      if (trimmed.length === 0) return UNSET
      const match = /^(\d+(?:\.\d+)?)\s*([KkMm]?)$/.exec(trimmed)
      if (match === null) return undefined
      const scale = match[2] === '' ? 1 : match[2] === 'K' || match[2] === 'k' ? 1000 : 1000000
      const value = Number(match[1]) * scale
      return Number.isFinite(value) && value > 0 ? value : undefined
    }

    /**
     * How many collapse/expand attempts the remount gets, and how long each
     * waits for the page to paint, in milliseconds. The card is re-seeded from
     * the Models page's own settings snapshot, which React re-renders
     * asynchronously after the write — so the first attempt can legitimately land
     * before it, and the wait is what a later one needs. The budget bounds a
     * hopeless case at roughly a second, after which the caller says so.
     */
    const REFRESH_ATTEMPTS = 8
    const REFRESH_RETRY_MS = 60

    /**
     * How long a burst of card edits is collected before it is written, in
     * milliseconds. Long enough to swallow a run of clicks on adjacent rows and the
     * keystrokes of one field, short enough that a single edit still looks
     * immediate.
     */
    const CARD_WRITE_DEBOUNCE_MS = 120

    /**
     * Whether a button's label (already trimmed) belongs to this takeover. An
     * exact match, never a prefix: the Models page carries other 添加… buttons
     * whose native meaning has nothing to do with this card's model list.
     */
    function isTakeoverLabel(label) {
      return TAKEOVER_LABELS.indexOf(label) !== -1
    }

    /**
     * The picker's own width.
     *
     * `Modal`'s card is `width: min(380px, 100%)` — sized for dsh's own list of
     * bare ids — while a row here carries an id plus up to five tags, and the
     * toolbar seven filter chips. `Modal` accepts only a class (its `className`
     * merges into the base card class and no style prop is forwarded), so the
     * width rides an injected rule; the `[role="dialog"]` qualifier is what beats
     * the base rule's specificity without `!important`.
     */
    const DIALOG_CLASS = 'kenari-catalog-dialog'

    /** Inject the picker's width rule once, at activation, so the first paint already has it. */
    function ensureDialogWidth() {
      if (document.querySelector(`style[data-${DIALOG_CLASS}]`) !== null) return
      const style = document.createElement('style')
      style.setAttribute(`data-${DIALOG_CLASS}`, '')
      style.textContent = `.${DIALOG_CLASS}[role="dialog"]{width:min(820px,92vw);max-width:92vw}`
      document.head.appendChild(style)
    }


    /**
     * Set-once and diagnostic parameters; folded away until asked for.
     *
     * `baseURL` lives here rather than in a user-facing group because it is not
     * a user setting: the address defaults to Kenari's one public endpoint. It
     * used to sit in an open 「连接」 group beside the Models page's own Kenari
     * card, which showed a *different* address (the model wire endpoint) — two
     * panels that looked like one thing, in two places, disagreeing.
     */
    const ADVANCED_FIELDS = [
      { field: 'baseURL', labelKey: 'field.baseURL', hintKey: 'field.baseURL.hint', kind: 'string' },
      { field: 'timeoutMs', labelKey: 'field.timeoutMs', kind: 'number' },
      { field: 'generationTimeoutMs', labelKey: 'field.generationTimeoutMs', hintKey: 'field.generationTimeoutMs.hint', kind: 'number' },
      { field: 'maxRetries', labelKey: 'field.maxRetries', hintKey: 'field.maxRetries.hint', kind: 'number' },
      { field: 'catalogCacheTtlMs', labelKey: 'field.catalogCacheTtlMs', kind: 'number' },
      { field: 'docsCacheTtlMs', labelKey: 'field.docsCacheTtlMs', kind: 'number' },
      { field: 'balanceCacheTtlMs', labelKey: 'field.balanceCacheTtlMs', kind: 'number' },
      { field: 'lowBalanceAlertRp', labelKey: 'field.lowBalanceAlertRp', hintKey: 'field.lowBalanceAlertRp.hint', kind: 'number' },
    ]

    /**
     * The name the key is stored under — read-only, and shown in the 密钥 group
     * beside the key's status rather than behind a fold.
     *
     * It belongs with the key, not with the set-once parameters: "which key is
     * this page talking about" and "which name is it stored under" are one
     * question, and splitting them put half the answer in a collapsed group.
     *
     * Read-only because renaming it would leave the model route resolving the
     * old reference (sessions fail with MISSING_CREDENTIAL) while the plugin's
     * tools keep working — a split that is invisible until a session breaks.
     */
    const KEY_REFERENCE_FIELD = { field: 'apiKeyEnv', labelKey: 'field.apiKeyEnv', hintKey: 'field.apiKeyEnv.hint', kind: 'readonly' }

    /**
     * The session-title settings, all of them, in one group that is never folded.
     *
     * The switch, the format and the length cap are one feature: the switch says
     * whether a prefix is written at all, and the other two say what it looks
     * like. Splitting the format and the cap off into 高级设置 made the reader
     * hunt in a second place for the other half of the thing they were editing.
     *
     * `sessionTitlePrefix` is part of the title text itself — dsh's title event
     * carries no separate prefix field — so these fields only decide what gets
     * written when a title is generated. They are not a display filter and they
     * do not reach back into existing sessions.
     */
    const SESSION_TITLE_FIELDS = [
      { field: 'sessionTitlePrefixEnabled', labelKey: 'sessionTitle.prefix', hintKey: 'sessionTitle.prefix.hint', kind: 'boolean' },
      { field: 'sessionTitlePrefix', labelKey: 'field.sessionTitlePrefix', hintKey: 'field.sessionTitlePrefix.hint', kind: 'string' },
      { field: 'sessionTitleMaxBytes', labelKey: 'field.sessionTitleMaxBytes', hintKey: 'field.sessionTitleMaxBytes.hint', kind: 'number' },
    ]

    /**
     * The switches that are decided when the plugin loads. They are read-only
     * here on purpose: a switch that does nothing until dsh restarts invites
     * "I turned it off and nothing happened", so this block states the values
     * and where to change them rather than offering a control that lies.
     */
    const RESTART_FIELDS = [
      { field: 'searchEnabled', labelKey: 'restart.search' },
      { field: 'fetchEnabled', labelKey: 'restart.fetch' },
      { field: 'fallbackEnabled', labelKey: 'restart.fallback' },
      { field: 'toolsEnabled', labelKey: 'restart.tools' },
      { field: 'budgetCapRp', labelKey: 'restart.budget', hintKey: 'restart.budget.hint' },
      { field: 'nativeAdapterEnabled', labelKey: 'restart.nativeAdapter' },
      { field: 'nativeProviderId', labelKey: 'restart.nativeProviderId' },
    ]

    /**
     * What this page deliberately does not show, and how to ask for it instead.
     *
     * The second element is the question a reader can actually type. It replaced
     * the tool name that used to sit there: the table was legible and useless,
     * because a tool name is not something a user can call — the agent is. Both
     * elements are locale keys, so the examples follow a language switch.
     */
    const TOOL_ONLY_FACTS = [
      { what: 'usage.balance', ask: 'usage.balance.ask' },
      { what: 'usage.billing', ask: 'usage.billing.ask' },
      { what: 'usage.catalog', ask: 'usage.catalog.ask' },
      { what: 'usage.tokens', ask: 'usage.tokens.ask' },
    ]

    /**
     * Every spec whose label and hint are locale keys. The build gate resolves
     * each one against both dictionaries, which is the only way a renamed or
     * misspelled key fails at build time instead of rendering as the raw key
     * `field.timeoutMs` on the page.
     */
    const LOCALE_SPECS = ADVANCED_FIELDS.concat([KEY_REFERENCE_FIELD], SESSION_TITLE_FIELDS, RESTART_FIELDS)

    /**
     * The selection box every row starts with, in both of its forms: a real
     * checkbox on a row you can add, and the ✓ marker on a row already in the
     * route. A native checkbox carries browser margin and its own intrinsic
     * size, so a plain span around the ✓ lined up with nothing — both forms get
     * this exact box, which is what keeps the ✓ and the checkboxes in one column.
     */
    const PICK_BOX = { width: '14px', height: '14px', flexShrink: 0, margin: 0, boxSizing: 'border-box' }

    /** The one monospace stack this page uses, for the things that are ids. */
    const MONO_FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace'

    /**
     * The one chip shape this page uses — the key-status badges and every
     * read-only value wear it, so "value" is a shape a reader learns once. Only
     * the shape is shared: the value chip is set a step larger and at full
     * strength, because it carries the payload while the label is its caption.
     */
    const CHIP = { display: 'inline-block', padding: '1px 7px', borderRadius: '999px', border: '1px solid rgba(127,127,127,0.4)' }

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '18px', fontSize: '13px', lineHeight: 1.6 },
      title: { margin: 0, fontSize: '15px', fontWeight: 600 },
      lead: { margin: 0, opacity: 0.75 },
      block: { border: '1px solid rgba(127,127,127,0.28)', borderRadius: '8px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' },
      blockTitle: { margin: 0, fontSize: '13px', fontWeight: 600 },
      // A foldable block head: the whole row is the hit target, and the state
      // word sits at the far end so it can be found without hunting for a caret.
      disclosure: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', width: '100%', padding: 0, border: 'none', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer', textAlign: 'left' },
      disclosureMark: { opacity: 0.6, fontSize: '12px', whiteSpace: 'nowrap' },
      row: { display: 'grid', gridTemplateColumns: 'minmax(160px, 260px) 1fr', gap: '8px 12px', alignItems: 'center' },
      label: { opacity: 0.85 },
      hint: { gridColumn: '2 / 3', opacity: 0.6, fontSize: '12px', marginTop: '-4px' },
      input: { width: '100%', boxSizing: 'border-box', padding: '4px 8px', border: '1px solid rgba(127,127,127,0.4)', borderRadius: '6px', background: 'transparent', color: 'inherit', font: 'inherit' },
      checkboxRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      pickBox: PICK_BOX,
      pickMark: { ...PICK_BOX, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', lineHeight: 1, opacity: 0.75 },
      mono: { fontFamily: MONO_FONT },
      badge: { ...CHIP, fontSize: '11px', opacity: 0.85 },
      // A read-only value, deliberately NOT the label's plain text: the two used
      // to sit one above the other in the same 13px tone, so "网页搜索" and
      // "已开启" read as two labels. The chip gives the value its own shape, and
      // the monospace keeps `KENARI_API_KEY` / `kenari-direct` legible as ids.
      value: { ...CHIP, fontSize: '12px', fontFamily: MONO_FONT },
      table: { width: '100%', borderCollapse: 'collapse' },
      cell: { textAlign: 'left', padding: '3px 6px', borderBottom: '1px solid rgba(127,127,127,0.18)', verticalAlign: 'top' },
      th: { fontWeight: 600, opacity: 0.6, fontSize: '12px' },
      notice: { margin: 0, opacity: 0.7, fontSize: '12px' },
      error: { margin: 0, color: '#c0392b', fontSize: '12px' },
      toolbar: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' },
      filterRow: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' },
      // Filter chips are buttons, but they wear the tag vocabulary: a capsule
      // outlined in BOTH states, where selecting only fills it and raises the
      // weight. dsh's `Pill` is the wrong atom here — it drops the outline when
      // idle, and its active fill is nearly the dialog's own background, so a
      // selected filter read as plain text instead of as a chip. Tokens keep
      // both themes honest.
      filterChip: { display: 'inline-flex', alignItems: 'center', height: '24px', padding: '0 10px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l4)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', font: 'inherit', fontSize: '12px', cursor: 'pointer' },
      filterChipOn: { display: 'inline-flex', alignItems: 'center', height: '24px', padding: '0 10px', borderRadius: '999px', border: '1px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-module-platform)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: '12px', fontWeight: 600, cursor: 'pointer' },
      // The search box is the one control dsh's Input atom cannot carry here:
      // that atom wraps the field in a fixed-height inline-flex box whose width
      // comes from a class this bundle cannot pass, so the field would size to
      // its placeholder. Styling the bare input with dsh's own tokens keeps the
      // look while leaving `flex` — the thing this layout needs — to inline style.
      search: { flex: '1 1 200px', minWidth: '140px', boxSizing: 'border-box', height: '32px', padding: '0 8px', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: '14px' },
      // The list scrolls inside the dialog: the picker must never push its own
      // footer off screen, because that footer is where 添加所选 lives.
      // Rows breathe: a row is a hit target and a fact set at once, and at the
      // density of a pure data grid the tags above and below each other read as
      // one block. The inner gap separates wrapped tag lines specifically.
      list: { maxHeight: 'min(52vh, 420px)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: '8px', padding: '8px' },
      // The row is one non-wrapping band: checkbox, id, then the tag column.
      // `alignItems: center` therefore centers the id against the tag block,
      // and the tags wrap inside their own column instead of restarting at the
      // row's left edge.
      item: { display: 'flex', flexWrap: 'nowrap', gap: '10px', alignItems: 'center', padding: '7px 8px', cursor: 'default' },
      itemId: { fontFamily: MONO_FONT, whiteSpace: 'nowrap', flexShrink: 0 },
      tagColumn: { display: 'flex', flexWrap: 'wrap', gap: '4px 8px', alignItems: 'center', flex: '1 1 auto', minWidth: 0 },
      // The body stacks four things that answer different questions (what can I
      // filter, how many are showing, the rows, what just happened); a gap keeps
      // them from reading as one paragraph of controls.
      body: { display: 'flex', flexDirection: 'column', gap: '14px' },
      dim: { opacity: 0.45, fontSize: '12px', whiteSpace: 'nowrap', flexShrink: 0 },
      footerNote: { marginRight: 'auto', opacity: 0.7, fontSize: '12px' },
    }

    /** Subscribe to one settings scope snapshot (stable handles for React). */
    function useScopeSnapshot(scope) {
      const subscribe = React.useCallback((onChange) => scope.subscribe(onChange), [scope])
      const getSnapshot = React.useCallback(() => scope.getSnapshot(), [scope])
      return React.useSyncExternalStore(subscribe, getSnapshot)
    }

    /**
     * One editable scalar. The draft is local until commit (blur or Enter), so a
     * half-typed number never lands in the settings document.
     */
    /**
     * One live field. The Host reads these live, so an edit applies at the next
     * operation; the badge says saved and promises nothing about timing.
     */
    function LiveField(props) {
      const { spec, committed, overridden, writable, onWrite } = props
      const label = t(spec.labelKey)
      const hint = spec.hintKey === undefined ? undefined : t(spec.hintKey)
      const [draft, setDraft] = React.useState(String(committed ?? ''))
      const [status, setStatus] = React.useState('idle')
      React.useEffect(() => {
        setDraft(String(committed ?? ''))
      }, [committed])

      // A boolean is a switch, so the click IS the write and what it writes is
      // the requested state — there is no draft, and therefore no blur or Enter
      // step to reach for.
      if (spec.kind === 'boolean') {
        const checked = committed === true
        const toggle = (next) => {
          if (next === checked) return
          setStatus('saving')
          onWrite(spec.field, next).then(
            () => setStatus('saved'),
            (err) => setStatus(`error:${String(err && err.message ? err.message : err)}`),
          )
        }
        return React.createElement(
          React.Fragment,
          null,
          React.createElement(
            'div',
            { style: styles.label },
            label,
            overridden ? React.createElement('span', { style: { ...styles.badge, marginLeft: '8px' } }, t('field.overridden')) : null,
            status === 'saved' ? React.createElement('span', { style: { ...styles.badge, marginLeft: '8px' } }, t('field.saved')) : null,
            typeof status === 'string' && status.startsWith('error:') ? React.createElement('span', { style: { ...styles.error, marginLeft: '8px' } }, status.slice(6)) : null,
          ),
          React.createElement(
            'div',
            { style: styles.checkboxRow },
            React.createElement(Switch, {
              checked,
              label,
              disabled: !writable || status === 'saving',
              onChange: toggle,
            }),
            React.createElement('span', { style: styles.dim }, checked ? t('field.on') : t('field.off')),
          ),
          hint === undefined ? null : React.createElement('div', { style: styles.hint }, hint),
        )
      }

      const commit = () => {
        const next = spec.kind === 'number' ? Number(draft) : draft
        if (spec.kind === 'number' && !Number.isFinite(next)) {
          setStatus('invalid')
          return
        }
        if (next === committed) {
          setStatus('idle')
          return
        }
        setStatus('saving')
        onWrite(spec.field, next).then(
          () => setStatus('saved'),
          (err) => setStatus(`error:${String(err && err.message ? err.message : err)}`),
        )
      }

      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'div',
          { style: styles.label },
          label,
          overridden ? React.createElement('span', { style: { ...styles.badge, marginLeft: '8px' } }, t('field.overridden')) : null,
          status === 'saved' ? React.createElement('span', { style: { ...styles.badge, marginLeft: '8px' } }, t('field.saved')) : null,
          status === 'invalid' ? React.createElement('span', { style: { ...styles.error, marginLeft: '8px' } }, t('field.invalidNumber')) : null,
          typeof status === 'string' && status.startsWith('error:') ? React.createElement('span', { style: { ...styles.error, marginLeft: '8px' } }, status.slice(6)) : null,
        ),
        React.createElement('input', {
          style: styles.input,
          type: spec.kind === 'number' ? 'number' : 'text',
          value: draft,
          disabled: !writable || status === 'saving',
          onChange: (event) => setDraft(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key === 'Enter') commit()
          },
        }),
        hint === undefined ? null : React.createElement('div', { style: styles.hint }, hint),
      )
    }

    /**
     * One read-only value with its label: a load-time switch, or a setting that
     * is deliberately not editable from this page.
     *
     * Label left, value right, on one line — the same two-column grid the key
     * status row above uses. The value wears a pill (see `styles.value`), which
     * is the whole point: stacked as two plain lines the label and the value
     * were indistinguishable, and a value that does not look like a value reads
     * as a second label.
     *
     * No per-row "restart required" badge — the block states that once, and seven
     * identical badges only train the reader to skip them. A boolean reads as
     * on/off rather than as `true`/`false`, because nothing here is a config file.
     */
    function ReadOnlyRow(props) {
      const { spec, value } = props
      const shown = typeof value === 'boolean' ? (value ? t('field.on') : t('field.off')) : String(value)
      return React.createElement(
        'div',
        { style: styles.row },
        React.createElement('div', { style: styles.label }, t(spec.labelKey)),
        React.createElement('div', null, React.createElement('span', { style: styles.value }, shown)),
        spec.hintKey === undefined ? null : React.createElement('div', { style: styles.hint }, t(spec.hintKey)),
      )
    }

    /**
     * A block whose body folds away, used for the parameters most readers never
     * touch. The whole heading row is the hit target — a fold that can only be
     * opened by hitting a 12px caret is a fold nobody opens — and `aria-expanded`
     * is what makes that row read as a control rather than as a label.
     */
    function Disclosure(props) {
      const { title, hint, children, defaultOpen } = props
      const [open, setOpen] = React.useState(defaultOpen === true)
      return React.createElement(
        'div',
        { style: styles.block },
        React.createElement(
          'button',
          {
            type: 'button',
            style: styles.disclosure,
            'aria-expanded': open,
            onClick: () => {
              setOpen(!open)
            },
          },
          React.createElement('span', { style: styles.blockTitle }, title),
          React.createElement('span', { style: styles.disclosureMark }, open ? t('ui.collapse') : t('ui.expand')),
        ),
        hint === undefined ? null : React.createElement('p', { style: styles.notice }, hint),
        open ? children : null,
      )
    }

    /**
     * Read one nested settings value without inventing defaults: a missing
     * ancestor answers `undefined`, which is what tells "the user layer does
     * not own this array" from "it owns an empty one".
     */
    function pathGet(root, path) {
      let node = root
      for (const segment of path) {
        if (typeof node !== 'object' || node === null) return undefined
        node = node[segment]
      }
      return node
    }

    /**
     * The models one provider profile currently serves, as the settings
     * document resolves them: the user layer when it owns the array (an
     * explicit list replaces the shipped catalog), else the composition layer.
     */
    function routeModelsOf(namespaceView, provider) {
      if (namespaceView === undefined) return []
      const path = ['providers', provider, 'models']
      const owned = pathGet(namespaceView.user, path)
      if (Array.isArray(owned)) return owned
      const inherited = pathGet(namespaceView.base, path)
      return Array.isArray(inherited) ? inherited : []
    }

    /**
     * Whether the subscription tag applies to one model.
     *
     * Free models are excluded on purpose: they cost nothing whether or not a
     * plan covers them, so "covered by a subscription" is noise on their row.
     * The filter and the row tag both read this one function, so a filtered
     * list never shows a row the tag contradicts.
     */
    function planCovered(model) {
      return model.free !== true && (model.plans || []).length > 0
    }

    /**
     * One model row's filter decision: every active dimension must match
     * (capabilities are ANDed too). `plan` is a yes/no dimension — "is a
     * subscription covering this paid model" — not a pick-one-of-N tier selector.
     */
    function matchesFilters(model, query, flags) {
      if (flags.plan === true && !planCovered(model)) return false
      if (flags.free === true && model.free !== true) return false
      for (const tag of CAPABILITY_TAGS) {
        if (flags[tag] === true && (model.tags || []).indexOf(tag) === -1) return false
      }
      if (query !== '') {
        const needle = query.toLowerCase()
        const haystack = `${model.id} ${model.name || ''} ${model.ownedBy || ''}`.toLowerCase()
        if (haystack.indexOf(needle) === -1) return false
      }
      return true
    }

    /**
     * 套餐内 and 免费 are one choice, not two.
     *
     * A free model is never plan-covered (`planCovered` excludes it on purpose),
     * so the two dimensions can never both match — selecting both could only ever
     * show an empty list. Picking one therefore releases the other, which is also
     * what the reader means by them: "show me what my plan pays for" and "show me
     * what costs nothing" are answers to the same question. Capability tags stay
     * multi-select (they are ANDed).
     */
    const EXCLUSIVE_FILTERS = { plan: 'free', free: 'plan' }

    /**
     * `embedding` stands alone.
     *
     * It does not describe a capability of a chat model — it is the marker of a
     * different population (the `?modality=embedding` catalog: embedding models,
     * which have no chat endpoint). Every other dimension describes chat models,
     * so ANDing this one with any of them can only ever match nothing, exactly
     * like the exclusive pair above. Picking it clears everything; picking
     * anything else clears it.
     */
    const SOLO_FILTERS = ['embedding']

    /** Toggle one filter dimension, enforcing the exclusive and solo rules above. */
    function toggleFilter(flags, tag) {
      const next = { ...flags }
      if (next[tag] === true) {
        delete next[tag]
        return next
      }
      if (SOLO_FILTERS.indexOf(tag) !== -1) return { [tag]: true }
      for (const solo of SOLO_FILTERS) delete next[solo]
      next[tag] = true
      const released = EXCLUSIVE_FILTERS[tag]
      if (released !== undefined) delete next[released]
      return next
    }

    /**
     * One render's worth of derived catalog facts, in one pure function so the
     * filter/count logic is testable without React (the build gate does that).
     * `known` is "already in the route's model array", which is what turns a
     * checkbox into a ✓ and keeps an existing entry out of the write.
     */
    function derivePanel(view, routeState, query, flags, picked) {
      const tags = Array.isArray(view.tags) && view.tags.length > 0 ? view.tags : CAPABILITY_TAGS
      const models = Array.isArray(view.models) ? view.models : []
      const known = {}
      for (const id of (routeState && routeState.modelIds) || []) known[id] = true
      const visible = models.filter((model) => matchesFilters(model, query.trim(), flags))
      const visibleIds = visible.map((model) => model.id)
      const addable = visible.filter((model) => known[model.id] !== true && picked.indexOf(model.id) !== -1)
      const allVisiblePicked = visibleIds.length > 0 && visibleIds.every((id) => picked.indexOf(id) !== -1)
      return { tags, models, known, visible, visibleIds, addable, allVisiblePicked }
    }

    /**
     * One Kenari route exists at a time, so the takeover and the mounted card
     * need no wiring: a module-level channel carries the click that opened the
     * picker (with the native button, for the fail-safe) to the component that
     * renders it. `mounted` is the takeover's guard — no listener means no
     * Kenari card on this page, and the native button is left alone.
     */
    function createOpenChannel() {
      const listeners = new Set()
      return {
        open(button) {
          for (const listener of [...listeners]) listener(button)
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        get mounted() {
          return listeners.size > 0
        },
      }
    }
    const pickerChannel = createOpenChannel()

    /** Set while this plugin re-clicks the native button itself, so that click cannot loop back here. */
    let takeoverBypassed = false

    /**
     * The provider card this bundle's marker identifies: the marker's nearest
     * list item, which is the element dsh renders one provider's card as.
     */
    function markedCard() {
      const marker = document.querySelector(`[${MARKER_ATTR}]`)
      if (marker === null || marker === undefined) return null
      const card = typeof marker.closest === 'function' ? marker.closest('li') : null
      return card === null ? marker.parentElement : card
    }

    /**
     * The card containing `start`, when that card is this bundle's; else null.
     *
     * The test is "does the marked card contain the button", not "is any
     * ancestor of the button marked": the `<ul>` that holds every provider card
     * also contains the marker, so walking up from the button until the marker
     * is found claims a sibling provider's identically labelled button. The
     * failure that guards against is silent — the wrong card's 添加模型 would
     * open this picker instead of adding its own row — so the scope is asked
     * from the marker's side, where it is exact.
     */
    function cardWithMarker(start) {
      const card = markedCard()
      if (card === null || typeof card.contains !== 'function') return null
      return card.contains(start) ? card : null
    }

    /**
     * Take over the Kenari card's 模型目录 buttons.
     *
     * A capture-phase listener on the document runs before React's
     * root-container listener, so `stopPropagation` here keeps dsh's own click
     * handler from ever seeing the event. The match is deliberately narrow: the
     * label is one of dsh's own, and the button must sit in a card containing
     * this bundle's marker. Everything else — another provider's identical
     * button, a click inside this plugin's own dialog (which is portaled to
     * `body`, so no marker is above it), a click this plugin originated —
     * propagates untouched, which is what keeps the native dialog reachable.
     *
     * A `disabled` button never dispatches a click at all, so the native
     * gates (adding while the editor is busy, fetching without a base URL) hold
     * here too without this function re-reading any of them.
     *
     * The same listener carries the two other halves of the card's live editing:
     * `input`/`change` on its fields (each edit is written as it is made) and a
     * click on 保存 (which, with every other field writing itself, is left holding
     * only the API key).
     */
    function installEntryTakeover(hooks) {
      const onRemove = hooks !== null && hooks !== undefined && typeof hooks.onRemove === 'function'
        ? hooks.onRemove
        : null
      const onField = hooks !== null && hooks !== undefined && typeof hooks.onField === 'function'
        ? hooks.onField
        : null
      const onKey = hooks !== null && hooks !== undefined && typeof hooks.onKey === 'function'
        ? hooks.onKey
        : null
      const onReset = hooks !== null && hooks !== undefined && typeof hooks.onReset === 'function'
        ? hooks.onReset
        : null

      /** One field edit, read off whichever input the event came from. */
      const onFieldEvent = (event) => {
        if (takeoverBypassed || !pickerChannel.mounted) return
        const field = event.target
        if (field === null || field === undefined || typeof field.getAttribute !== 'function') return
        const card = cardWithMarker(field)
        if (card === null) return
        // The key is not written here — it is what the card's 保存 commits — but
        // its content is what decides whether that button is offered at all.
        if (field.type === 'password') {
          syncFooterVisibility(card)
          return
        }
        if (onField === null) return
        const target = fieldTargetOf(ariaLabelOf(field))
        if (target === null) return
        onField(card, target, typeof field.value === 'string' ? field.value : '')
      }

      const onClickCapture = (event) => {
        if (takeoverBypassed || !pickerChannel.mounted) return
        const target = event.target
        if (target === null || target === undefined || typeof target.closest !== 'function') return
        const button = target.closest('button')
        if (button === null) return
        const label = typeof button.textContent === 'string' ? button.textContent.trim() : ''
        // dsh's own 编辑 toggle, riding along on this listener because the fold it
        // mounts is where this plugin's entry points live. Nothing is prevented or
        // stopped here: the click has to reach dsh for the card to open at all.
        if (EDIT_LABELS.indexOf(label) !== -1) {
          if (cardWithMarker(button) !== null) void revealEditorFoldSoon()
          return
        }
        const card = cardWithMarker(button)
        // 恢复默认模型, and 保存: both are dsh actions this plugin takes over rather
        // than lets run. The reset drops the route's stored array (the card then
        // re-mounts showing the shipped presets, exactly as dsh's draft edit
        // looked), and 保存 — which the card now shows under the key — commits the
        // typed key, because everything else on the card has already been written.
        if (card !== null && RESET_LABELS.indexOf(label) !== -1 && onReset !== null) {
          event.preventDefault()
          event.stopPropagation()
          onReset(card)
          return
        }
        if (card !== null && SUBMIT_LABELS.indexOf(label) !== -1 && onKey !== null) {
          const input = keyInputOf(card)
          const value = input === null || typeof input.value !== 'string' ? '' : input.value
          event.preventDefault()
          event.stopPropagation()
          onKey(card, value)
          return
        }
        // dsh's per-row removal, taken over the same way 添加模型 is — but here the
        // click is deliberately NOT prevented, because the card has to drop the row
        // itself for the click to look immediate. What this adds is the write: the
        // stored route loses the model now instead of at 保存, so a deletion lands
        // exactly like an addition does, and the draft that dsh just edited is
        // re-seeded from the document a moment later.
        if (card !== null && onRemove !== null) {
          const removalRow = removalRowOf(button, card)
          if (removalRow !== -1) {
            const shown = cardModelIds(card)
            const removed = shown === null ? undefined : shown[removalRow]
            if (typeof removed === 'string' && removed.length > 0) onRemove(card, removed)
            return
          }
        }
        if (!isTakeoverLabel(label)) return
        if (card === null) return
        event.preventDefault()
        event.stopPropagation()
        pickerChannel.open(button)
      }
      document.addEventListener('click', onClickCapture, true)
      document.addEventListener('input', onFieldEvent, true)
      document.addEventListener('change', onFieldEvent, true)
      return () => {
        document.removeEventListener('click', onClickCapture, true)
        document.removeEventListener('input', onFieldEvent, true)
        document.removeEventListener('change', onFieldEvent, true)
      }
    }

    /** A node's aria-label, or '' when it has none. */
    function ariaLabelOf(node) {
      if (node === null || node === undefined || typeof node.getAttribute !== 'function') return ''
      const label = node.getAttribute('aria-label')
      return typeof label === 'string' ? label : ''
    }

    /** Whether an already-read aria-label is one of dsh's per-row removal buttons. */
    function isRemoveLabel(label) {
      for (let at = 0; at < REMOVE_LABELS.length; at += 1) {
        if (label.indexOf(`${REMOVE_LABELS[at]} `) === 0) return true
      }
      return false
    }

    /**
     * Which model row a removal button owns, or -1 when this click is not one of
     * dsh's removal buttons.
     *
     * Counted from the card's own removal buttons, which `ModelListEditor` renders
     * one per row in row order — the order {@link cardModelIds} reads, so the two
     * indexes name the same row. Counting beats parsing the trailing number out of
     * the aria-label: the label's own numbering would be another dsh detail to
     * track, while the DOM here is already the source of the rows.
     * @param button - the clicked button.
     * @param card - the provider's card element.
     * @returns the row index, or -1.
     */
    function removalRowOf(button, card) {
      if (!isRemoveLabel(ariaLabelOf(button))) return -1
      if (card === null || card === undefined || typeof card.querySelectorAll !== 'function') return -1
      const buttons = card.querySelectorAll('button')
      if (buttons === null || buttons === undefined || typeof buttons.length !== 'number') return -1
      let index = 0
      for (let at = 0; at < buttons.length; at += 1) {
        const node = buttons[at]
        if (node === button) return index
        if (isRemoveLabel(ariaLabelOf(node))) index += 1
      }
      return -1
    }

    /**
     * The list left after dropping one model id, in order.
     *
     * Filters by id rather than by index: the row the user clicked is named by
     * what that row shows, and a stored array whose order drifted must not make
     * the click delete its neighbour.
     * @param models - the stored model entries.
     * @param id - the id to drop.
     * @returns a new list without it.
     */
    function withoutModel(models, id) {
      const kept = []
      for (let at = 0; at < models.length; at += 1) {
        const model = models[at]
        if (model !== null && model !== undefined && model.id === id) continue
        kept.push(model)
      }
      return kept
    }

    /**
     * One route model array with the edited rows' fields applied.
     *
     * Each row is found by the id its card row shows, so an edit follows the row
     * the user typed into rather than a position that may have moved. The id is
     * also the one field whose edit erases that link — the draft then names an id
     * the document does not have — and only that case (and only while both lists
     * still have the same length) falls back to the row's position.
     *
     * Entries are copied, never rebuilt: this card edits four fields of a model
     * and knows nothing about the rest of them, so anything it does not edit has
     * to survive the write.
     * @param models - the stored model entries.
     * @param draftIds - the ids the card's rows show, or null when they cannot be read.
     * @param rows - edited row index to the fields changed in it.
     * @returns a new array, or the same one when nothing changed.
     */
    function patchModels(models, draftIds, rows) {
      if (rows === null || rows === undefined || typeof rows.size !== 'number' || rows.size === 0) return models
      const next = models.map((model) => (model !== null && typeof model === 'object' ? { ...model } : model))
      let touched = false
      for (const [index, patch] of rows) {
        let target = -1
        const draftId = draftIds !== null && index < draftIds.length ? draftIds[index] : undefined
        if (typeof draftId === 'string' && draftId.length > 0) {
          for (let at = 0; at < next.length; at += 1) {
            const entry = next[at]
            if (entry !== null && entry !== undefined && typeof entry === 'object' && entry.id === draftId) {
              target = at
              break
            }
          }
        }
        if (target === -1 && draftIds !== null && draftIds.length === next.length) target = index
        const entry = target === -1 ? undefined : next[target]
        if (entry === null || entry === undefined || typeof entry !== 'object') continue
        for (const key of Object.keys(patch)) {
          const value = patch[key]
          if (value === UNSET) {
            if (key in entry) {
              delete entry[key]
              touched = true
            }
            continue
          }
          if (entry[key] !== value) {
            entry[key] = value
            touched = true
          }
        }
      }
      return touched ? next : models
    }

    /**
     * The row's editing toggle, found from the row a taken-over button sits in.
     *
     * Scoped to `closest('li')` — the same per-provider list item the marker
     * lookup uses — so a sibling provider's identical 编辑 button is never claimed.
     * @param row - the provider's list item, or null.
     * @returns the toggle button, or null when this DOM is not the shape we know.
     */
    function editToggleOf(row) {
      if (row === null || row === undefined || typeof row.querySelectorAll !== 'function') return null
      const buttons = row.querySelectorAll('button')
      for (let index = 0; index < buttons.length; index += 1) {
        const node = buttons[index]
        const label = typeof node.textContent === 'string' ? node.textContent.trim() : ''
        if (EDIT_LABELS.indexOf(label) !== -1) return node
      }
      return null
    }

    /**
     * The model ids the card's own rows currently show, or null when `row` is
     * not the shape this bundle knows.
     *
     * Read straight from the row inputs rather than from any snapshot: it is the
     * DOM the user is looking at that has to carry the answer.
     * @param row - the provider's list item, or null.
     * @returns the ids in row order, or null when the row cannot be read.
     */
    function cardModelIds(row) {
      if (row === null || row === undefined || typeof row.querySelectorAll !== 'function') return null
      const inputs = row.querySelectorAll('input')
      if (inputs === null || inputs === undefined || typeof inputs.length !== 'number') return null
      const ids = []
      for (let index = 0; index < inputs.length; index += 1) {
        const node = inputs[index]
        if (node === null || node === undefined) continue
        const label = typeof node.getAttribute === 'function' ? node.getAttribute('aria-label') : null
        if (typeof label !== 'string') continue
        for (let at = 0; at < MODEL_ID_LABELS.length; at += 1) {
          if (label.indexOf(MODEL_ID_LABELS[at]) === 0) {
            ids.push(typeof node.value === 'string' ? node.value : '')
            break
          }
        }
      }
      return ids
    }

    /**
     * Let the page paint the state this plugin just changed. The remount below
     * has to wait for React, and a fixed delay is the only thing that can: the
     * work being waited on is another component's render, which no DOM event
     * announces.
     * @returns a promise settling after one retry interval.
     */
    function afterPaint() {
      return new Promise((resolve) => {
        setTimeout(resolve, REFRESH_RETRY_MS)
      })
    }

    /**
     * Re-open the card's 自定义设置 fold, which the remount re-creates closed.
     *
     * The models this plugin adds live inside that fold, so without this the
     * list refreshes out of sight and the user still has to expand it to see
     * what they added. `open` is the browser's own attribute here — React renders
     * this `<details>` without controlling it, so setting it is not a state
     * write it would undo.
     * @param row - the provider's list item.
     */
    function openEditorFold(row) {
      if (row === null || row === undefined || typeof row.querySelector !== 'function') return
      const fold = row.querySelector('details')
      if (fold !== null && fold !== undefined) fold.open = true
    }

    /** The card's API-key field: the one password input it renders. */
    function keyInputOf(card) {
      if (card === null || card === undefined || typeof card.querySelectorAll !== 'function') return null
      const inputs = card.querySelectorAll('input')
      if (inputs === null || inputs === undefined || typeof inputs.length !== 'number') return null
      for (let at = 0; at < inputs.length; at += 1) {
        if (inputs[at] !== null && inputs[at] !== undefined && inputs[at].type === 'password') return inputs[at]
      }
      return null
    }

    /**
     * The card's action row: the smallest ancestor of the commit button that also
     * holds the dismiss one. Its class is a CSS-module hash; this shape is not.
     * @param card - the provider's card element.
     * @returns the row, or null when the card is not the shape this bundle knows.
     */
    function footerOf(card) {
      if (card === null || card === undefined || typeof card.querySelectorAll !== 'function') return null
      const buttons = card.querySelectorAll('button')
      if (buttons === null || buttons === undefined || typeof buttons.length !== 'number') return null
      let submit = null
      let cancel = null
      for (let at = 0; at < buttons.length; at += 1) {
        const node = buttons[at]
        if (node === null || node === undefined) continue
        const label = typeof node.textContent === 'string' ? node.textContent.trim() : ''
        if (submit === null && SUBMIT_LABELS.indexOf(label) !== -1) submit = node
        if (cancel === null && CANCEL_LABELS.indexOf(label) !== -1) cancel = node
      }
      if (submit === null || cancel === null) return null
      let footer = submit.parentElement
      while (footer !== null && footer !== undefined && footer !== card
        && typeof footer.contains === 'function' && !footer.contains(cancel)) {
        footer = footer.parentElement
      }
      return footer === null || footer === undefined || footer === card ? null : footer
    }

    /**
     * Show the card's 取消/保存 only while the key field holds something.
     *
     * Those two buttons now commit exactly one thing — the key — so with the field
     * empty they offer a commit of nothing, and the card is cleaner without them.
     * dsh never pre-fills the field (its placeholder is 已配置——输入新值可替换),
     * so a card opens with them hidden and they appear on the first keystroke.
     *
     * `hidden` would lose to dsh's own `display` rule for that row, hence the
     * inline style, cleared rather than set to a literal so the row keeps looking
     * the way dsh drew it.
     * @param card - the provider's card element.
     */
    function syncFooterVisibility(card) {
      const footer = footerOf(card)
      if (footer === null || footer.style === null || footer.style === undefined) return
      const input = keyInputOf(card)
      const typed = input !== null && typeof input.value === 'string' && input.value.trim().length > 0
      footer.style.display = typed ? '' : 'none'
    }

    /**
     * Put the card's 取消/保存 directly under the API-key field.
     *
     * Everything else on this card writes itself now — the model list on add and
     * delete, and every other field on its own edit — so the pair that used to
     * mean "commit this whole card" only has the key left to commit. Moving it
     * there is what makes that read off the screen instead of needing an
     * explanation.
     *
     * A move, not a copy: dsh's own nodes keep their own handlers, and React only
     * re-creates them when it re-creates the editor — at which point this runs
     * again from {@link arrangeCard}. Nothing is removed from the DOM, so there is
     * no node React would later fail to remove.
     * @param card - the provider's card element.
     */
    function parkFooterUnderKey(card) {
      const footer = footerOf(card)
      if (footer === null) return
      const keyInput = keyInputOf(card)
      const keyField = keyInput === null ? null : keyInput.parentElement
      if (keyField === null || keyField === undefined || keyField.parentElement === null) return
      if (keyField.nextElementSibling !== footer) keyField.parentElement.insertBefore(footer, keyField.nextElementSibling)
      syncFooterVisibility(card)
    }

    /**
     * Put one card's editor into the shape this plugin's copy describes: the model
     * list unfolded, and the footer under the key it now belongs to.
     *
     * Called from both places the editor is (re)built: the 编辑 click dsh handles
     * itself, and this plugin's own remount after a write.
     * @param row - the provider's list item.
     */
    function arrangeCard(row) {
      openEditorFold(row)
      if (row !== null && row !== undefined) parkFooterUnderKey(row)
    }

    /**
     * The folds this bundle has already revealed, one entry per editor mount.
     *
     * React re-creates the `<details>` every time the card reopens, so a fresh
     * element is revealed again while the one a user collapsed by hand is left
     * alone — the memory has to be per element, not per card.
     */
    const revealedFolds = new WeakSet()

    /**
     * Open one card's 自定义设置 fold, once per element.
     *
     * Why it is needed: that fold holds the model list AND the two buttons this
     * plugin takes over, and dsh renders it closed. A card opened by hand
     * therefore buries the list — and this plugin's way in — one click deep,
     * every single time. Opening it as the editor appears is what makes the
     * models visible on the spot.
     *
     * Once per element, deliberately: the user's collapse is theirs to make, and
     * re-opening it on every mutation would fight them out of the control.
     * @param card - the provider's card element, or null.
     */
    function revealFoldOf(card) {
      if (card === null || card === undefined || typeof card.querySelector !== 'function') return
      const fold = card.querySelector('details')
      if (fold === null || fold === undefined) return
      if (revealedFolds.has(fold)) return
      revealedFolds.add(fold)
      fold.open = true
    }

    /** Reveal the mounted Kenari card's fold; a no-op while no card is on screen. */
    function revealEditorFold() {
      const card = markedCard()
      revealFoldOf(card)
      parkFooterUnderKey(card)
    }

    /**
     * Reveal the fold of the editor a click just toggled.
     *
     * The card's own 编辑 toggle is dsh's button, so the editor it mounts does
     * not exist yet when the click is handled: the reveal is retried across one
     * paint. A toggle that closed the card instead finds no fold and does
     * nothing, which is what keeps a hand-collapsed fold from snapping back.
     * @returns settlement after both reveal attempts.
     */
    async function revealEditorFoldSoon() {
      revealEditorFold()
      await afterPaint()
      revealEditorFold()
    }

    /** Whether the card's editor is mounted right now. */
    function editorMounted(row) {
      return row !== null
        && row !== undefined
        && typeof row.querySelector === 'function'
        && row.querySelector('details') !== null
    }

    /**
     * Leave one card open, with its model list unfolded.
     *
     * Called after a remount, including a remount whose list never agreed: the
     * user opened this picker from an expanded card, and collapsing it would
     * hide the very list the dialog's copy is talking about. Re-open is a click
     * on the same toggle (the card is only ever closed by one), and the fold is
     * re-opened because the remount re-creates it closed.
     * @param row - the provider's list item.
     * @param wasOpen - whether the editor was mounted when the work began.
     * @returns settlement after the card has been re-opened.
     */
    async function leaveEditorOpen(row, wasOpen) {
      // Only a card that was open to begin with is restored: a user who collapsed
      // it while the write was in flight asked for it closed, and a deletion must
      // not fight that the way a dialog's own success may override a stale draft.
      if (wasOpen && !editorMounted(row)) {
        const toggle = editToggleOf(row)
        if (toggle !== null && typeof toggle.click === 'function') {
          toggle.click()
          await afterPaint()
        }
      }
      arrangeCard(row)
    }

    /**
     * Re-mount the editing card this bundle's picker was opened from, and report
     * success only once its list actually lists what was just written.
     *
     * Why it is needed: the card seeds its model list once, at mount, and
     * deliberately does not follow a pushed settings refresh — that is what keeps
     * a half-typed API key from being overwritten. A write made from this plugin's
     * modal therefore lands *behind* the card, and its list would stay stale until
     * something remounted it. Collapse-then-expand IS that remount, and it is the
     * card's own control rather than a synthetic dialog close.
     *
     * The draft it discards was already invalid: the card's revision fence is stale
     * after this plugin's write, so its next save would be refused as stale anyway.
     *
     * Why the result is checked instead of assumed: the remount re-seeds from the
     * Models page's snapshot, and a single collapse/expand issued the moment the
     * write resolves can run before React has re-rendered that page. The card then
     * looks refreshed and still lists the OLD models — the exact bug this exists to
     * fix, wearing the success copy. So each attempt is compared against the ids it
     * must show, spaced by a paint, until it agrees or the budget runs out.
     *
     * Fail-open — no toggle found (a dsh release renamed it), or a list that never
     * agrees, returns false and the caller falls back to the copy that names the
     * manual way. Either way the card is left open with its fold unfolded, since
     * the user came here from an expanded card — a collapsed one would hide both
     * the list and the copy talking about it.
     * @param button - the native button the takeover intercepted.
     * @param addedIds - the model ids the card's list must contain to count as refreshed.
     * @returns whether the card now lists every added id.
     */
    async function refreshProviderEditor(button, addedIds) {
      if (button === null || button === undefined || typeof button.closest !== 'function') return false
      const wanted = Array.isArray(addedIds) ? addedIds.filter((id) => typeof id === 'string') : []
      // Resolved ONCE, before anything is clicked: the button that opened the
      // picker lives INSIDE the editor, so collapsing detaches it and every later
      // `button.closest('li')` would answer null. The row itself survives — dsh
      // keys it by provider and only the editor inside it comes and goes.
      const row = button.closest('li')
      if (row === null || row === undefined) return false
      return remountEditorWhile(row, (shown) => wanted.every((id) => shown.indexOf(id) !== -1))
    }

    /**
     * Collapse and expand one card until its list agrees, then leave it as the
     * user had it.
     *
     * The loop is shared by both writes this plugin makes to a route: an addition
     * wants its ids to appear, a removal wants its id to be gone, and everything
     * else — the pair of clicks, the paint between them, the budget, the row
     * resolved once, the fold re-opened — is the same either way.
     * @param row - the provider's list item.
     * @param agrees - reads the ids the card now lists and answers whether the change is on screen.
     * @returns whether the card ever agreed.
     */
    /**
     * Every scroller above one node, with where each is scrolled to.
     *
     * Recorded because a remount collapses the card first, and a collapse shortens
     * the page: the browser clamps a scroller's `scrollTop` to the shorter content
     * the moment it shrinks, so by the time the card is expanded again the position
     * is already gone. Reading it before the first click is the only way to put it
     * back.
     * @param node - the element the card's scrolling is measured from.
     * @returns the positions, in the order they were found.
     */
    function scrollMarksOf(node) {
      const marks = []
      let parent = node === null || node === undefined ? null : node.parentElement
      while (parent !== null && parent !== undefined) {
        if (typeof parent.scrollTop === 'number'
          && (parent.scrollTop > 0 || parent.scrollHeight > parent.clientHeight)) {
          marks.push({ node: parent, top: parent.scrollTop, left: parent.scrollLeft })
        }
        parent = parent.parentElement
      }
      const root = typeof document === 'undefined' ? null : document.scrollingElement
      if (root !== null && root !== undefined && typeof root.scrollTop === 'number') {
        marks.push({ node: root, top: root.scrollTop, left: root.scrollLeft })
      }
      return marks
    }

    /**
     * Put every recorded scroller back where it was.
     *
     * Called after the card has been expanded again, and again after the fold is
     * re-opened: the fold changes the height too, so restoring before that would
     * be clamped all over again.
     * @param marks - what {@link scrollMarksOf} returned.
     */
    function restoreScroll(marks) {
      for (let at = 0; at < marks.length; at += 1) {
        const mark = marks[at]
        if (typeof mark.node.scrollTop !== 'number') continue
        mark.node.scrollTop = mark.top
        mark.node.scrollLeft = mark.left
      }
    }

    async function remountEditorWhile(row, agrees) {
      const wasOpen = editorMounted(row)
      const marks = scrollMarksOf(row)
      let agreed = false
      for (let attempt = 0; attempt < REFRESH_ATTEMPTS && !agreed; attempt += 1) {
        const toggle = editToggleOf(row)
        if (toggle === null || typeof toggle.click !== 'function') break
        toggle.click()
        // The second click must land after React commits the first: collapse is a
        // state update, and re-reading `open` inside the same click would expand
        // nothing. The row node survives the collapse (it is keyed by provider), so
        // the toggle is looked up again there instead of reusing a detached node.
        await afterPaint()
        const again = editToggleOf(row)
        if (again !== null && typeof again.click === 'function') again.click()
        await afterPaint()
        const shown = cardModelIds(row)
        if (shown === null) break
        agreed = agrees(shown)
        restoreScroll(marks)
      }
      await leaveEditorOpen(row, wasOpen)
      // After the fold, not before: re-opening it changes the height too, and a
      // position restored under it would be clamped a second time.
      restoreScroll(marks)
      return agreed
    }

    /**
     * The Kenari glyph on the settings panel's own nav rail.
     *
     * dsh's shell picks that glyph from a hardcoded id switch (`navIcon(row.id)`:
     * models / agent-presets / plugins, else the settings gear) and a section's
     * registration carries only `id`/`order`/`label` — there is no icon field to
     * fill in. What a plugin CAN own is the DOM, and the row for our own section
     * is the one nav button whose label is our own label. So the swap is done
     * here, and the image comes from this plugin's same-origin route
     * (`/api/kenari.favicon`), the same way the catalog view does.
     *
     * The glyph is NOT replaced: dsh's `<svg>` stays exactly where React put it
     * and the injected rule only hides it. React deletes the whole panel subtree
     * when settings closes and calls `removeChild` for every host node it
     * rendered, so a node this bundle had detached would throw there — an
     * `Uncaught NotFoundError` on every close, from code that looks fine.
     *
     * Fail-open: the attribute is set only after the image has actually loaded,
     * so a 404 (a deploy whose package omits `assets/`) leaves dsh's gear alone
     * instead of leaving an empty 16px hole.
     */
    const NAV_ICON_ATTR = 'data-kenari-nav-icon'

    /**
     * The injected `<style>`'s own marker. Deliberately NOT `NAV_ICON_ATTR`: the
     * two would otherwise be indistinguishable to `[data-kenari-nav-icon]`, and
     * the row lookup would have to care which of the two it had matched.
     */
    const NAV_ICON_STYLE_ATTR = 'data-kenari-nav-icon-style'

    /** Where the browser fetches the glyph; must match `KENARI_FAVICON_PATH`. */
    const NAV_ICON_URL = '/api/kenari.favicon'

    /** Must match the `label` this bundle registers for its settings section. */
    const SETTINGS_SECTION_LABEL = 'Kenari'

    /**
     * Scope for the row lookup. The settings panel is the only dialog on the
     * page that renders a nav rail, and "Kenari" is also painted well outside
     * it (the Models page's route row, the composer's model menu), so the match
     * is confined to a `<nav>` inside a `[role="dialog"]` rather than to any
     * button anywhere.
     */
    const NAV_ROW_SELECTOR = '[role="dialog"] nav button'

    /**
     * The settings nav rail's button for one section label, or null.
     *
     * Text is the only stable identity a nav row has — its class is a CSS-module
     * hash and its position moves with the registered order — which is the same
     * reason the 模型目录 takeover matches labels.
     */
    function settingsNavButton(root, label) {
      const buttons = root.querySelectorAll(NAV_ROW_SELECTOR)
      for (let index = 0; index < buttons.length; index += 1) {
        const text = typeof buttons[index].textContent === 'string' ? buttons[index].textContent.trim() : ''
        if (text === label) return buttons[index]
      }
      return null
    }

    /** The rule that swaps dsh's nav glyph for this plugin's icon. */
    function navIconRule() {
      return `[${NAV_ICON_ATTR}] svg{display:none}`
        + `[${NAV_ICON_ATTR}]::before{content:"";flex:none;width:16px;height:16px;border-radius:4px;`
        + `background:url("${NAV_ICON_URL}") center/contain no-repeat}`
    }

    /** Inject the nav-icon rule once, so the first paint of the panel already has it. */
    function ensureNavIconStyle() {
      if (document.querySelector(`style[${NAV_ICON_STYLE_ATTR}]`) !== null) return
      const style = document.createElement('style')
      style.setAttribute(NAV_ICON_STYLE_ATTR, '')
      style.textContent = navIconRule()
      document.head.appendChild(style)
    }

    /**
     * Mark the nav row owning one section label, if it is on the page.
     *
     * The `::before` icon is 16px and `flex: none`, and the svg it hides is
     * 16px and `flex: none` too, so the row's geometry (icon, 8px gap, label)
     * is byte-for-byte what dsh laid out.
     */
    function markNavRow(root, label) {
      const button = settingsNavButton(root, label)
      if (button === null) return null
      button.setAttribute(NAV_ICON_ATTR, '')
      return button
    }

    /** Whether the route actually serves the image; the licence to hide dsh's glyph. */
    let navIconReady = false

    /** The row already marked, while it is still connected — the lookup's short-circuit. */
    let navRow = null

    function patchSettingsNavIcon(root) {
      if (!navIconReady) return false
      if (navRow !== null && navRow.isConnected === true) return true
      navRow = markNavRow(root, SETTINGS_SECTION_LABEL)
      return navRow !== null
    }

    /**
     * Put the icon on the nav rail.
     *
     * The panel mounts only while settings is open, so the row is found by
     * watching for the panel's own insertion rather than by polling: the
     * document-wide lookup runs only for a mutation that could have added a
     * dialog, and short-circuits on the remembered row while it is connected.
     * Plain chat streaming — every other mutation in this app — never reaches
     * the lookup at all.
     */
    function installSettingsNavIcon() {
      ensureNavIconStyle()
      // The probe is what licenses hiding the gear: `onload` proves the route
      // answers, `onerror` silently leaves dsh's own glyph in place.
      const probe = document.createElement('img')
      probe.onload = () => {
        navIconReady = true
        patchSettingsNavIcon(document)
      }
      probe.onerror = () => {}
      probe.src = NAV_ICON_URL

      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType !== 1) continue
            // The panel's root is the overlay, not the dialog itself, so both
            // the node and its subtree are asked.
            if (node.matches('[role="dialog"]') || node.querySelector('[role="dialog"]') !== null) {
              patchSettingsNavIcon(document)
              return
            }
          }
        }
      })
      if (document.body !== null && document.body !== undefined) {
        observer.observe(document.body, { childList: true, subtree: true })
      }
      return () => observer.disconnect()
    }

    /**
     * Everything the catalog shows and does, in one hook feeding the dialog's
     * every part, so the toolbar, the summary and the write all agree on what is
     * currently filtered.
     *
     * There is one dialog. The Kenari settings page used to open a second,
     * read-only copy of it; that page now points at the Models page instead,
     * because a catalog browser that cannot add anything just duplicated it.
     */
    function useCatalogPanel(props) {
      const { routeNs, routeProvider, loadPanel, addModels, onAdded, onComplete } = props
      const [state, setState] = React.useState({ status: 'loading' })
      const [reloads, setReloads] = React.useState(0)
      const [query, setQuery] = React.useState('')
      const [flags, setFlags] = React.useState({})
      const [picked, setPicked] = React.useState([])
      const [write, setWrite] = React.useState({ status: 'idle' })

      // The target route travels as two strings, never as an object: a fresh
      // object in the dependency array would re-run this effect on every
      // render, and the state it sets re-renders — an endless fetch loop.
      React.useEffect(() => {
        let live = true
        const route = routeNs !== undefined && routeProvider !== undefined
          ? { settingsNs: routeNs, provider: routeProvider }
          : undefined
        setState({ status: 'loading' })
        loadPanel(route).then(
          (answer) => {
            if (live) setState({ status: 'ready', panel: answer })
          },
          (err) => {
            if (live) setState({ status: 'error', message: String(err && err.message ? err.message : err) })
          },
        )
        return () => {
          live = false
        }
      }, [loadPanel, reloads, routeNs, routeProvider])

      const view = state.status === 'ready' ? state.panel.view : {}
      const routeState = state.status === 'ready' ? state.panel.route : undefined
      const derived = derivePanel(view, routeState, query, flags, picked)

      const toggleFlag = (tag) => {
        setFlags((current) => toggleFilter(current, tag))
      }
      const togglePick = (id) => {
        setPicked((current) => current.indexOf(id) === -1
          ? current.concat([id])
          : current.filter((entry) => entry !== id))
      }
      const toggleVisible = () => {
        setPicked((current) => derived.allVisiblePicked
          ? current.filter((id) => derived.visibleIds.indexOf(id) === -1)
          : current.concat(derived.visibleIds.filter((id) => current.indexOf(id) === -1)))
      }
      const clearFilters = () => {
        setQuery('')
        setFlags({})
      }

      /**
       * Write the picked-and-not-yet-in-route models into the route, then
       * re-read so the ✓ marks and the count come from the document rather than
       * from what this function assumed it wrote.
       */
      const submit = () => {
        const profiles = derived.addable.map((model) => model.profile)
        if (profiles.length === 0 || routeNs === undefined || routeProvider === undefined) return
        setWrite({ status: 'saving' })
        addModels({ settingsNs: routeNs, provider: routeProvider }, profiles).then(
          async (result) => {
            if (result.ok !== true) {
              setWrite({ status: 'error', message: result.message })
              return
            }
            // The card behind this modal seeds its list once, at mount, and does not
            // follow pushed settings refreshes — so it has to be remounted for the
            // write to show up in it. `onAdded` answers whether the card now really
            // lists those ids; its own verification is what keeps this copy honest,
            // because a remount that ran too early looks identical from here.
            let remounted = false
            if (typeof onAdded === 'function') {
              try {
                remounted = (await onAdded(profiles.map((profile) => profile.id))) === true
              } catch (_remountFailure) {
                remounted = false
              }
            }
            // Confirmed on the card itself: the rows are already on screen behind
            // this dialog, so the dialog has nothing left to say and gets out of
            // the way. An unconfirmed refresh keeps it open, because then its copy
            // is the only thing that can tell the user to reopen the card.
            if (remounted && typeof onComplete === 'function') {
              onComplete()
              return
            }
            setWrite({
              status: 'added',
              message: remounted
                ? t('catalog.added', { count: profiles.length })
                : t('catalog.addedStale', { count: profiles.length }),
            })
            setPicked([])
            setReloads((current) => current + 1)
          },
          (err) => setWrite({ status: 'error', message: String(err && err.message ? err.message : err) }),
        )
      }

      return { state, view, routeState, derived, query, setQuery, flags, picked, write, toggleFlag, togglePick, toggleVisible, clearFilters, submit }
    }

    /**
     * How a capability id reads to a person. The ids stay the host's vocabulary
     * — they are what `kenari_list_models` reports and what the filter matches —
     * so only the display is translated. An id with no translation prints as
     * itself rather than as a missing-key artifact, which is what lets the host
     * add a capability without this bundle shipping a new string.
     */
    function tagLabel(tag) {
      const key = `tag.${tag}`
      const label = t(key)
      return label === key ? tag : label
    }

    /** The search box, the filter chips, and the select-all control. */
    function CatalogToolbar(props) {
      const { panel } = props
      // Every dimension is one chip of the same kind: plan, free, then the
      // capability tags. No plan NAMES appear anywhere — a reader filtering by
      // subscription wants "covered by a plan", not a pick-one-of-five tier.
      // 套餐内 and 免费 are one choice rather than two (see `toggleFilter`).
      const chips = ['plan', 'free'].concat(panel.derived.tags).map((tag) => React.createElement(
        'button',
        {
          key: tag,
          type: 'button',
          style: panel.flags[tag] === true ? styles.filterChipOn : styles.filterChip,
          'aria-pressed': panel.flags[tag] === true,
          onClick: () => {
            panel.toggleFlag(tag)
          },
        },
        tag === 'plan' ? t('filter.plan') : tag === 'free' ? t('filter.free') : tagLabel(tag),
      ))
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        React.createElement(
          'div',
          { style: styles.toolbar },
          React.createElement('input', {
            style: styles.search,
            type: 'search',
            value: panel.query,
            placeholder: t('catalog.searchPlaceholder'),
            'aria-label': t('catalog.searchLabel'),
            onChange: (event) => {
              panel.setQuery(event.target.value)
            },
          }),
          React.createElement(
            Button,
            { variant: 'ghost', size: 'sm', disabled: panel.derived.visible.length === 0, onClick: panel.toggleVisible },
            panel.derived.allVisiblePicked ? t('catalog.clearAll') : t('catalog.selectAll'),
          ),
          React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: panel.clearFilters }, t('catalog.clear')),
        ),
        React.createElement('div', { style: styles.filterRow }, chips),
      )
    }

    /** What the current filter is showing, and what the one non-obvious tag means. */
    function CatalogSummary(props) {
      const { derived } = props
      return React.createElement(
        'p',
        { style: styles.notice },
        t('catalog.summary', {
          visible: derived.visible.length,
          total: derived.models.length,
          addable: derived.addable.length,
        }),
      )
    }

    /** The model rows: pick box, id, then the tag column. */
    function CatalogRows(props) {
      const { derived, picked, togglePick } = props
      if (derived.visible.length === 0) {
        return React.createElement('p', { style: styles.notice }, t('catalog.empty'))
      }
      return React.createElement(
        'div',
        { style: styles.list },
        derived.visible.map((model) => React.createElement(
          'label',
          { key: model.id, style: styles.item },
          // A model already in the route cannot be picked again, so its cell is
          // a ✓ in the very box the checkboxes occupy: the column keeps one
          // width and the row still reports what it is.
          derived.known[model.id] !== true
            ? React.createElement('input', {
              type: 'checkbox',
              style: styles.pickBox,
              checked: picked.indexOf(model.id) !== -1,
              onChange: () => {
                togglePick(model.id)
              },
            })
            : React.createElement('span', { style: styles.pickMark }, '✓'),
          // The id alone: it is the exact string a request and the route entry
          // use, and the vendor's display name beside it only made every row
          // wider without adding anything a reader acts on. The name still
          // travels in the payload (search matches it, and it is what gets
          // written into the route's model entry).
          React.createElement('code', { style: styles.itemId }, model.id),
          // The tags are their OWN wrapping column, not siblings of the id in
          // one wrapping row: as siblings, a wrapped line restarts at the row's
          // left edge, which reads as a stray line rather than as the row's
          // tags. In a column they wrap in place, and the id centers against
          // the block. Every tag uses dsh's one `outline` tone, so the facts
          // read as a set rather than one badge shouting louder than the rest.
          React.createElement(
            'span',
            { style: styles.tagColumn },
            // No 免费 tag: a free model says so in its own id (`...:free`), so
            // the badge only repeated what the row already showed. The 免费
            // FILTER stays, and it still reads the payload's `free` field
            // rather than the suffix — if Kenari ever marks a model free
            // without renaming it, filtering keeps working.
            (model.tags || []).map((tag) => React.createElement(Tag, { key: tag, tone: 'neutral' }, tagLabel(tag))),
            // One boolean tag, never one badge per plan: the only question a
            // row answers is "does a subscription cover this PAID model", and
            // the tier that happens to cover it is not the reader's business.
            planCovered(model) ? React.createElement(Tag, { tone: 'neutral' }, t('filter.plan')) : null,
            model.chatCapable === false ? React.createElement('span', { style: styles.dim }, t('catalog.chatOnly')) : null,
            derived.known[model.id] === true ? React.createElement('span', { style: styles.dim }, t('catalog.inRoute')) : null,
          ),
        )),
      )
    }

    /**
     * The catalog as dsh's own dialog: same Modal chrome, same Button/Pill/Tag
     * tokens as the dialog dsh's own 获取可用模型 opens, with the capability
     * and plan dimensions added into that one surface.
     *
     * It is mounted only while open (see the two call sites), so a closed dialog
     * costs no request and every opening starts from a fresh query and pick set.
     */
    function ModelCatalogModal(props) {
      const { onClose, nativeButton, loadPanel, addModels, routeNs, routeProvider } = props
      const panel = useCatalogPanel({
        routeNs,
        routeProvider,
        loadPanel,
        addModels,
        // The card this modal was opened from is the row's editing card; remounting
        // it is what makes the freshly written models visible in its list. The ids
        // travel with the ask so the remount can check its own work, and a confirmed
        // refresh closes this dialog rather than reporting what the card now shows.
        onAdded: (addedIds) => refreshProviderEditor(nativeButton, addedIds),
        onComplete: onClose,
      })

      /**
       * The way back out: close this dialog, then re-click the button dsh
       * rendered, with the takeover bypassed for that one click so the native
       * flow runs. Only offered when this plugin's own view failed to load.
       */
      const fallbackToNative = () => {
        onClose()
        if (nativeButton !== null && nativeButton !== undefined && typeof nativeButton.click === 'function') {
          takeoverBypassed = true
          try {
            nativeButton.click()
          } finally {
            setTimeout(() => {
              takeoverBypassed = false
            }, 0)
          }
        }
      }

      const footer = React.createElement(
        React.Fragment,
        null,
        React.createElement('span', { style: styles.footerNote }, t('catalog.footerNote')),
        React.createElement(Button, { variant: 'outline', onClick: onClose }, t('catalog.cancel')),
        React.createElement(
          Button,
          {
            variant: 'primary',
            disabled: panel.derived.addable.length === 0 || panel.write.status === 'saving',
            onClick: panel.submit,
          },
          panel.write.status === 'saving'
            ? t('catalog.saving')
            : t('catalog.submit', { count: panel.derived.addable.length }),
        ),
      )

      const plansError = viewPlansError(panel)
      const body = panel.state.status === 'loading'
        ? React.createElement('p', { style: styles.notice }, t('catalog.loading'))
        : panel.state.status === 'error'
          ? React.createElement(
            React.Fragment,
            null,
            React.createElement('p', { style: styles.error }, t('catalog.error', { message: panel.state.message })),
            nativeButton !== undefined
              ? React.createElement('p', { style: { margin: 0 } }, React.createElement(
                Button,
                { variant: 'outline', size: 'sm', onClick: fallbackToNative },
                t('catalog.fallback'),
              ))
              : null,
          )
          : React.createElement(
            'div',
            { style: styles.body },
            React.createElement(CatalogToolbar, { panel }),
            React.createElement(CatalogSummary, { derived: panel.derived }),
            plansError !== undefined ? React.createElement('p', { style: styles.error }, plansError) : null,
            React.createElement(CatalogRows, { derived: panel.derived, picked: panel.picked, togglePick: panel.togglePick }),
            panel.routeState !== undefined && panel.routeState.writable === false
              ? React.createElement('p', { style: styles.notice }, t('catalog.readonly'))
              : null,
            panel.write.status === 'added' ? React.createElement('p', { style: styles.notice }, panel.write.message) : null,
            panel.write.status === 'error' ? React.createElement('p', { style: styles.error }, panel.write.message) : null,
          )

      return React.createElement(
        Modal,
        {
          open: true,
          onClose,
          className: DIALOG_CLASS,
          title: t('catalog.title'),
          closeLabel: t('catalog.close'),
          description: t('catalog.description'),
          footer,
        },
        body,
      )
    }

    /** The plan-table failure sentence, or `undefined` when the table loaded. */
    function viewPlansError(panel) {
      const plansError = panel.view.plansError
      return plansError === undefined
        ? undefined
        : t('catalog.plansError', { message: plansError })
    }

    /**
     * The Models-page seat. dsh dispatches `settings.models.provider-card` for
     * every route the pi-ai namespace owns, into that route's own card, so the
     * hidden marker it renders here is how the takeover recognizes the card —
     * and the reason another pi-ai route renders nothing at all.
     */
    function ModelPickerHost(props) {
      const [request, setRequest] = React.useState(null)
      React.useEffect(() => pickerChannel.subscribe((button) => {
        setRequest({ button })
      }), [])
      // The seat dispatches for every route the pi-ai namespace owns; this
      // picker is about Kenari, so another pi-ai route renders nothing — not
      // even the marker, which is what keeps the takeover from claiming that
      // route's otherwise identical button.
      if (props.provider === undefined || props.provider.provider !== KENARI_PROVIDER) return null
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('span', { [MARKER_ATTR]: 'kenari', style: { display: 'none' } }),
        request === null
          ? null
          : React.createElement(ModelCatalogModal, {
            nativeButton: request.button,
            onClose: () => {
              setRequest(null)
            },
            routeNs: PI_AI_NS,
            routeProvider: props.provider.provider,
            loadPanel: props.loadPanel,
            addModels: props.addModels,
          }),
      )
    }

    /** Adapter-discovered models for this route: names and capacities, no prices. */
    /** How many models a collapsed list shows before it offers to open up. */
    const MODEL_PREVIEW_COUNT = 3

    /**
     * A context window as a reader-facing size: 1048576 reads as "1M". Nobody
     * compares exact token counts here; the magnitude is the fact being checked.
     */
    function formatContextWindow(tokens) {
      if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return undefined
      if (tokens >= 1_000_000) return `${String(Math.round(tokens / 100_000) / 10)}M`
      if (tokens >= 1_000) return `${String(Math.round(tokens / 1_000))}K`
      return String(tokens)
    }

    /**
     * Which rows a list shows. Pulled out of the component so the build gate can
     * drive it directly: "three, then all when asked" is exactly the kind of rule
     * that stays quietly wrong when the only way to reach it is a click.
     */
    function visibleModels(models, expanded) {
      return expanded ? models : models.slice(0, MODEL_PREVIEW_COUNT)
    }

    /**
     * Rows carrying a name a reader can use, given the catalog's display names.
     *
     * The discovery listing is not a source of names: dsh fills `name` with the
     * raw id when the endpoint publishes none (`llm-pi-ai/src/discovery.ts`), and
     * Kenari publishes a name for only 8 of its 80-odd models. So a row printed
     * the id twice — once as the id, once as the name — and the second copy said
     * nothing the first had not. The plugin's own view derives a display name for
     * every model (`Agnes 2.0 Flash`), which is also the string written into the
     * route profile, so the list reads it from there.
     *
     * When nothing resolves and the listing's name is just the id, the cell is
     * left empty rather than reprinting it: the id column already carries it.
     */
    function withDisplayNames(models, names) {
      return models.map((model) => {
        const resolved = names[model.id]
        if (typeof resolved === 'string' && resolved.length > 0 && resolved !== model.id) {
          return { ...model, name: resolved }
        }
        const listed = typeof model.name === 'string' ? model.name : ''
        return { ...model, name: listed === model.id ? '' : listed }
      })
    }

    /**
     * The models the current route can use.
     *
     * The provider reports its whole catalog — dozens of rows — and a reader who
     * came here to check one thing should not have to scroll past all of them. So
     * a collapsed list shows the first few, says how many there are in total, and
     * opens on request.
     */
    function ModelList(props) {
      const { loadModels } = props
      const [state, setState] = React.useState({ status: 'loading' })
      const [expanded, setExpanded] = React.useState(false)
      React.useEffect(() => {
        let live = true
        loadModels().then(
          (answer) => {
            if (live) setState({ status: 'ready', ...answer })
          },
          (err) => {
            if (live) setState({ status: 'error', message: String(err && err.message ? err.message : err) })
          },
        )
        return () => {
          live = false
        }
      }, [loadModels])

      if (state.status === 'loading') return React.createElement('p', { style: styles.notice }, t('models.loading'))
      if (state.status === 'error') {
        return React.createElement('p', { style: styles.error }, t('models.error', { message: state.message }))
      }
      if (state.models.length === 0) {
        return React.createElement('p', { style: styles.notice }, t('models.empty'))
      }
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('p', { style: styles.notice }, t('models.summary', { route: state.route, count: state.models.length })),
        React.createElement(
          'table',
          { style: styles.table },
          // Headed, unlike the usage table's first version: three unlabelled
          // columns where two of them printed the same string left the reader to
          // guess which was which. dsh's own vocabulary names them.
          React.createElement(
            'thead',
            null,
            React.createElement(
              'tr',
              null,
              React.createElement('th', { style: { ...styles.cell, ...styles.th } }, t('models.colId')),
              React.createElement('th', { style: { ...styles.cell, ...styles.th } }, t('models.colName')),
              React.createElement('th', { style: { ...styles.cell, ...styles.th } }, t('models.colContext')),
            ),
          ),
          React.createElement(
            'tbody',
            null,
            visibleModels(state.models, expanded).map((model) => {
              const context = formatContextWindow(model.contextWindow)
              return React.createElement(
                'tr',
                { key: model.id },
                React.createElement('td', { style: styles.cell }, React.createElement('code', { style: styles.mono }, model.id)),
                React.createElement('td', { style: styles.cell }, model.name || ''),
                // The header carries the word, so the cell carries only the
                // magnitude: "Context window | 872K", not "Context window | 872K context".
                React.createElement('td', { style: { ...styles.cell, whiteSpace: 'nowrap', opacity: 0.7 } }, context === undefined ? '' : context),
              )
            }),
          ),
        ),
        state.models.length > MODEL_PREVIEW_COUNT
          ? React.createElement(
            Button,
            {
              variant: 'ghost',
              size: 'sm',
              'aria-expanded': expanded,
              onClick: () => {
                setExpanded(!expanded)
              },
            },
            expanded ? t('ui.collapse') : t('models.expandAll', { count: state.models.length }),
          )
          : null,
      )
    }

    /**
     * Credential status read through the settings-controller Remote namespace:
     * `describe()` returns `{configured, source, writable}` and never a value, so
     * this row can state the key's health without a code path that could leak it.
     */
    function KeyStatus(props) {
      const { describeKey, keyRef } = props
      const [state, setState] = React.useState({ status: 'loading' })
      React.useEffect(() => {
        let live = true
        describeKey(keyRef).then(
          (info) => {
            if (live) setState({ status: 'ready', info })
          },
          (err) => {
            if (live) setState({ status: 'error', message: String(err && err.message ? err.message : err) })
          },
        )
        return () => {
          live = false
        }
      }, [describeKey, keyRef])

      if (state.status === 'loading') return React.createElement('span', { style: styles.notice }, t('key.checking'))
      if (state.status === 'error') return React.createElement('span', { style: styles.error }, t('key.checkFailed', { message: state.message }))
      const info = state.info
      if (info === undefined) return React.createElement('span', { style: styles.error }, t('key.missingRef'))
      return React.createElement(
        'span',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
        React.createElement('span', { style: styles.badge }, info.configured ? t('key.configured') : t('key.missing')),
        info.source ? React.createElement('span', { style: styles.badge }, t('key.source', { source: info.source })) : null,
        React.createElement('span', { style: styles.badge }, info.writable ? t('key.editable') : t('key.locked')),
      )
    }

    /**
     * The Kenari settings page.
     *
     * Ordered by what a reader arrives for: is it connected (key status and the
     * name it is stored under), see what it serves, decide about session titles
     * — and then, behind folds, the two groups most readers never open. Nothing
     * here names a config key, a schema field or an endpoint: the file-level
     * facts live in the documentation.
     */
    function KenariSection(props) {
      const { scope, loadModels, describeKey } = props
      const snapshot = useScopeSnapshot(scope)
      const value = snapshot.value || {}
      // A field's PRESENCE in the raw user layer is what marks it overridden —
      // an override equal to the composition default is still an override.
      const user = snapshot.user || {}
      const writable = snapshot.writable === true

      const write = (field, next) => scope.set(field, next)

      // Only speak up when there is something to say. "Settings are in sync" on
      // a page that is always in sync is one more line to read and skip.
      const statusNotice = snapshot.status === 'ready'
        ? undefined
        : snapshot.status === 'loading' ? t('connection.status.loading') : t('connection.status.unavailable')

      // The untouched default is the reference the Host would resolve anyway, so
      // the key-status row reports on the key actually in effect.
      const keyRef = value.apiKeyEnv || 'KENARI_API_KEY'

      const liveField = (spec) => (spec.kind === 'readonly'
        ? React.createElement(ReadOnlyRow, { key: spec.field, spec, value: value[spec.field] })
        : React.createElement(LiveField, {
          key: spec.field,
          spec,
          committed: value[spec.field],
          overridden: Object.prototype.hasOwnProperty.call(user, spec.field),
          writable,
          onWrite: write,
        }))

      return React.createElement(
        'div',
        { style: styles.root },
        React.createElement('h3', { style: styles.title }, t('page.title')),
        React.createElement('p', { style: styles.lead }, t('page.lead')),

        // A status card, not a settings card: it answers "does Kenari work, and
        // if not, where do I fix it" — the key itself is entered on the model
        // route's own card, where dsh's password input lives.
        React.createElement(
          'div',
          { style: styles.block },
          React.createElement('h4', { style: styles.blockTitle }, t('connection.title')),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('div', { style: styles.label }, t('connection.keyStatus')),
            React.createElement(KeyStatus, { describeKey, keyRef }),
          ),
          // The name the key is stored under sits with the key, not behind the
          // 高级设置 fold: it answers the same question the status badges do.
          liveField(KEY_REFERENCE_FIELD),
          React.createElement('p', { style: styles.notice }, t('connection.notice')),
          statusNotice === undefined ? null : React.createElement('p', { style: styles.notice }, statusNotice),
        ),

        React.createElement(
          'div',
          { style: styles.block },
          React.createElement('h4', { style: styles.blockTitle }, t('models.title')),
          React.createElement(ModelList, { loadModels }),
          React.createElement('p', { style: styles.notice }, t('models.hint')),
        ),

        React.createElement(
          'div',
          { style: styles.block },
          React.createElement('h4', { style: styles.blockTitle }, t('sessionTitle.title')),
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            SESSION_TITLE_FIELDS.map(liveField),
          ),
        ),

        React.createElement(
          Disclosure,
          { title: t('advanced.title'), hint: t('advanced.hint') },
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' } },
            ADVANCED_FIELDS.map(liveField),
          ),
        ),

        React.createElement(
          Disclosure,
          { title: t('restart.title'), hint: t('restart.hint') },
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' } },
            RESTART_FIELDS.map((spec) => React.createElement(ReadOnlyRow, { key: spec.field, spec, value: value[spec.field] })),
          ),
        ),

        React.createElement(
          'div',
          { style: styles.block },
          React.createElement('h4', { style: styles.blockTitle }, t('usage.title')),
          React.createElement('p', { style: styles.notice }, t('usage.hint')),
          React.createElement(
            'table',
            { style: styles.table },
            React.createElement(
              'thead',
              null,
              React.createElement(
                'tr',
                null,
                React.createElement('th', { style: { ...styles.cell, ...styles.th } }, t('usage.what')),
                React.createElement('th', { style: { ...styles.cell, ...styles.th } }, t('usage.ask')),
              ),
            ),
            React.createElement(
              'tbody',
              null,
              TOOL_ONLY_FACTS.map((fact) =>
                React.createElement(
                  'tr',
                  { key: fact.what },
                  React.createElement('td', { style: styles.cell }, t(fact.what)),
                  // The right-hand cell is the thing to say out loud, so it is
                  // the example question rather than a tool name: a tool name is
                  // not something a reader can call — the agent is.
                  React.createElement('td', { style: styles.cell }, t(fact.ask)),
                ),
              ),
            ),
          ),
        ),
      )
    }

    /**
     * Services this bundle needs: the slot ledger, the Remotes, our settings
     * scope, and the locale service that answers this bundle's own copy.
     */
    const inject = ['slots', 'locale', 'remote', 'remote.llm', 'remote.credentials', 'remote.settings', 'settingsScope']

    /**
     * Register the Kenari settings page once the shell has declared
     * `settings.section` (a registration before that declaration throws).
     */
    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NS })
      // The route's own scope, held beside this plugin's: writes to the pi-ai
      // section go through it rather than through a bare `settings.mutate`, and
      // that is what folds the write answer into the shared settings mirror the
      // Models page reads. See `addModels`.
      const routeScope = ctx.settingsScope.bind({ namespace: PI_AI_NS })

      // Bind the translator before anything can render: the components below
      // call it, and every one of them is reachable from here on.
      t = ctx.locale.bind(NS)

      /**
       * The catalog's display names, keyed by id, read from this plugin's own
       * same-origin view. Best-effort on purpose: a name is a nicety and the id
       * is the fact, so a view that will not load must not take the list with it.
       */
      const displayNames = async () => {
        try {
          const view = await loadModelView()
          const names = {}
          for (const model of view.models || []) {
            if (typeof model.id === 'string' && typeof model.name === 'string') names[model.id] = model.name
          }
          return names
        } catch {
          return {}
        }
      }

      /**
       * Model discovery is per owning settings namespace, and a route pi-ai does
       * not ship also needs the endpoint to ask: `llm-pi-ai` owns the shipped
       * preset route, while the plugin's own adapter (phase 5) owns its route
       * under this plugin's namespace. Try the shipped route first so the card
       * works out of the box, then the native one.
       *
       * The listing carries no usable names (see `withDisplayNames`), so the
       * rows are joined with this plugin's own view before they are returned.
       */
      const loadModels = async () => {
        const settings = scope.getSnapshot().value || {}
        const providerId = settings.nativeProviderId || 'kenari-direct'
        // pi-ai wants the API base ([OI] shape, /v1 included); our REST base is
        // the bare host, so normalize the same way the Host client does.
        const restBase = String(settings.baseURL || 'https://kenari.id').replace(/\/+$/, '')
        const apiBase = restBase.endsWith('/v1') ? restBase : `${restBase}/v1`
        const candidates = [
          { ns: 'llm-pi-ai', request: { provider: 'kenari', baseURL: apiBase, api: 'openai-completions' } },
          { ns: NS, request: { provider: providerId } },
        ]
        const failures = []
        for (const candidate of candidates) {
          const result = await ctx.remote.llm.discoverModels(candidate.ns, candidate.request)
          if (result.ok && result.value.length > 0) {
            return { route: candidate.request.provider, models: withDisplayNames(result.value, await displayNames()) }
          }
          failures.push(`${candidate.request.provider}: ${result.ok ? t('models.routeEmpty') : result.error.code}`)
        }
        throw new Error(t('models.noRoute', { failures: failures.join('; ') }))
      }

      /** `describe()` is the only key reader: it answers state, never the value. */
      const describeKey = async (keyRef) => {
        const result = await ctx.remote.credentials.describe([keyRef])
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        return result.value[keyRef]
      }

      /**
       * The Host-computed model view, read through the plugin's own same-origin
       * Fetch route. Same-origin means the browser session that already
       * authenticates Remote calls carries this too — no CORS, no new Host API
       * package, and the payload (tags, plan coverage) is built once, Host-side.
       */
      const loadModelView = async () => {
        const response = await fetch(MODEL_VIEW_PATH, { headers: { accept: 'application/json' } })
        if (!response.ok) {
          const detail = await response.json().catch(() => undefined)
          const message = detail && detail.error ? detail.error : `HTTP ${response.status}`
          throw new Error(message)
        }
        return response.json()
      }

      /** The pi-ai namespace view, or undefined when it is not mounted. */
      const readPiAi = async () => {
        const described = await ctx.remote.settings.describe()
        if (!described.ok) return { failure: `${described.error.code}: ${described.error.message}` }
        const namespaces = described.value.namespaces || []
        const view = namespaces.find((entry) => entry.ns === PI_AI_NS)
        return { view, writable: described.value.writable === true }
      }

      /** Panel data: the catalog view, plus (when the route is addressable) what it already serves. */
      const loadPanel = async (route) => {
        const view = await loadModelView()
        if (route === undefined) return { view }
        const read = await readPiAi()
        if (read.failure !== undefined || read.view === undefined) return { view }
        return {
          view,
          route: {
            modelIds: routeModelsOf(read.view, route.provider).map((model) => model && model.id).filter((id) => typeof id === 'string'),
            writable: read.writable,
          },
        }
      }

      /**
       * Append the selected profiles to the route's model array.
       *
       * A stored array REPLACES the shipped one, so the write must carry the
       * list that is currently in effect (user layer when it owns the array,
       * else the composition layer the patch pinned) and only append. Without
       * that, adding one paid model would silently drop the free presets.
       *
       * The write goes through this route's settings scope, not a bare
       * `settings.mutate`: the scope folds the write answer into the shared
       * settings mirror the Models page reads, so the editing card this plugin
       * remounts right after reads the new list. A bare wire write would leave
       * that mirror waiting for the Host's push, which the remount can outrun.
       *
       * The scope reports no failure — a refused or unanswered write reloads the
       * mirror and settles — so success is decided by the document afterwards,
       * never by what this function assumed it wrote.
       */
      const addModels = async (route, profiles) => {
        const read = await readPiAi()
        if (read.failure !== undefined) return { ok: false, message: read.failure }
        if (read.view === undefined) return { ok: false, message: t('catalog.noNamespace', { ns: PI_AI_NS }) }
        if (read.writable !== true) return { ok: false, message: t('catalog.settingsReadOnly') }
        const existing = routeModelsOf(read.view, route.provider)
        const byId = new Map()
        for (const model of existing) {
          if (model && typeof model.id === 'string') byId.set(model.id, model)
        }
        for (const profile of profiles) if (!byId.has(profile.id)) byId.set(profile.id, profile)
        await routeScope.mutate(
          [{ op: 'set', path: ['providers', route.provider, 'models'], value: [...byId.values()] }],
          read.view.revision,
        )
        const after = await readPiAi()
        const present = new Set(
          routeModelsOf(after.view, route.provider)
            .map((model) => (model && typeof model.id === 'string' ? model.id : undefined))
            .filter((id) => id !== undefined),
        )
        const missing = profiles.filter((profile) => !present.has(profile.id)).length
        return missing === 0
          ? { ok: true }
          : { ok: false, message: t('catalog.writeRefused', { count: missing }) }
      }

      /**
       * Everything the card writes, collected and flushed as one write.
       *
       * The card used to hand dsh a draft and wait for its 保存; now every edit
       * lands in the document as it is made — a removed row, a restored default
       * catalog, a renamed model, an endpoint, a display name — and 保存 is left
       * holding only the API key, which is why it sits under that field.
       *
       * Collected rather than written per edit, for two reasons. Each write is a
       * read-modify-write of the document, so overlapping ones would fence the
       * second on a revision the first had already superseded and it would be
       * refused; and a burst of keystrokes should be one write, not one per
       * character (which is also what keeps a capacity typed as `1M` from being
       * stored as `1` on its way through).
       *
       * The only edits that re-mount the card are the ones its own draft cannot
       * show: removals and the default-catalog restore. A field edit is already on
       * screen where the user typed it, and re-mounting under a caret would take
       * the caret with it.
       */
      const pendingEdits = {
        card: null,
        removals: new Set(),
        rows: new Map(),
        paths: new Map(),
        reset: false,
        timer: null,
        tail: Promise.resolve(),
      }

      const cardEdit = (card, edit) => {
        pendingEdits.card = card
        if (edit.removal !== undefined) pendingEdits.removals.add(edit.removal)
        if (edit.reset === true) pendingEdits.reset = true
        if (edit.path !== undefined) pendingEdits.paths.set(edit.path, edit.value)
        if (edit.row !== undefined) {
          const at = pendingEdits.rows.get(edit.row.index) ?? {}
          pendingEdits.rows.set(edit.row.index, { ...at, [edit.row.model]: edit.row.value })
        }
        if (pendingEdits.timer !== null) return
        pendingEdits.timer = setTimeout(flushCardEdits, CARD_WRITE_DEBOUNCE_MS)
      }

      const flushCardEdits = () => {
        pendingEdits.timer = null
        const batch = {
          card: pendingEdits.card,
          removals: [...pendingEdits.removals],
          rows: new Map(pendingEdits.rows),
          paths: new Map(pendingEdits.paths),
          reset: pendingEdits.reset,
        }
        pendingEdits.removals.clear()
        pendingEdits.rows.clear()
        pendingEdits.paths.clear()
        pendingEdits.reset = false
        const run = () => applyCardEdits(batch)
        pendingEdits.tail = pendingEdits.tail.then(run, run)
      }

      const applyCardEdits = async (batch) => {
        try {
          const read = await readPiAi()
          if (read.failure !== undefined || read.view === undefined) return
          // A read-only deployment keeps dsh's own behaviour: the card stays a
          // draft, and it is left alone rather than re-mounted out from under it.
          if (read.writable !== true) return
          const modelsPath = ['providers', KENARI_PROVIDER, 'models']
          const ops = []
          let afterWrite = null
          if (batch.reset) {
            ops.push({ op: 'unset', path: modelsPath })
            afterWrite = () => true
          } else {
            const existing = routeModelsOf(read.view, KENARI_PROVIDER)
            let next = existing
            let changed = false
            for (let at = 0; at < batch.removals.length; at += 1) {
              const shortened = withoutModel(next, batch.removals[at])
              if (shortened.length !== next.length) changed = true
              next = shortened
            }
            const patched = patchModels(next, batch.card === null ? null : cardModelIds(batch.card), batch.rows)
            if (patched !== next) changed = true
            next = patched
            if (changed) {
              ops.push({ op: 'set', path: modelsPath, value: next })
              if (batch.removals.length > 0) {
                const removed = batch.removals
                afterWrite = (shown) => removed.every((id) => shown.indexOf(id) === -1)
              }
            }
          }
          for (const [field, value] of batch.paths) {
            ops.push(value === UNSET
              ? { op: 'unset', path: ['providers', KENARI_PROVIDER, field] }
              : { op: 'set', path: ['providers', KENARI_PROVIDER, field], value })
          }
          if (ops.length === 0) return
          await routeScope.mutate(ops, read.view.revision)
          if (afterWrite !== null && batch.card !== null) await remountEditorWhile(batch.card, afterWrite)
        } catch (_cardWriteFailure) {
          // Fail-open: nothing re-seeds the card, so a write that did not land
          // shows as the old value in the card's own list rather than as a silent
          // success.
        }
      }

      /** Take one edit off the card's inputs and queue it. */
      const onCardField = (card, target, raw) => {
        if (target.where === 'card') {
          cardEdit(card, { path: target.path, value: raw.trim().length === 0 ? UNSET : raw })
          return
        }
        if (target.capacity === true) {
          const value = capacityOf(raw)
          // Not a count this card can mean: the text stays where the user put it
          // rather than being stored as something it is not.
          if (value === undefined) return
          cardEdit(card, { row: { index: target.index, model: target.model, value } })
          return
        }
        const value = raw.trim()
        if (target.model === 'id') {
          // An id is the entry's identity: a blank or duplicated one names nothing
          // the adapter could address, so it stays in the card unhidden.
          if (value.length === 0) return
          const shown = cardModelIds(card)
          if (shown !== null && shown.filter((id) => id === value).length > 1) return
        }
        cardEdit(card, { row: { index: target.index, model: target.model, value: value.length === 0 ? UNSET : value } })
      }

      /**
       * Commit the key the card's 保存 now stands for.
       *
       * The value crosses to the Host and never comes back (the credential seam
       * has no read path), so this is the one edit with nothing to verify against:
       * a store that is refused leaves the field filled and says so, rather than
       * pretending.
       */
      const onCardKey = (card, raw) => {
        const value = raw.trim()
        if (value.length === 0) {
          closeCard(card)
          return
        }
        void storeKey(card, value)
      }

      const storeKey = async (card, value) => {
        const read = await readPiAi()
        if (read.failure !== undefined || read.view === undefined || read.writable !== true) return
        const profile = pathGet(read.view.user, ['providers', KENARI_PROVIDER])
        const named = profile !== null && typeof profile === 'object' ? profile.apiKeyEnv : undefined
        const keyRef = typeof named === 'string' && named.length > 0 ? named : DEFAULT_KEY_REF
        try {
          await ctx.remote.credentials.set(keyRef, value)
        } catch (err) {
          showCardFailure(card, String(err !== null && err !== undefined && err.message ? err.message : err))
          return
        }
        // dsh's own save records the reference the key was stored under; without it
        // the route still resolves the same name by derivation, but the card would
        // go on showing an endpoint it no longer names.
        if (typeof named !== 'string' || named.length === 0) {
          try {
            await routeScope.mutate([{ op: 'set', path: ['providers', KENARI_PROVIDER, 'apiKeyEnv'], value: keyRef }], read.view.revision)
          } catch (_referenceFailure) { /* the derived name is the same one */ }
        }
        clearCardFailure(card)
        closeCard(card)
      }

      /** Fold the card away, the way dsh folds it after its own save. */
      function closeCard(card) {
        const toggle = editToggleOf(card)
        if (toggle !== null && typeof toggle.click === 'function') toggle.click()
      }

      // The one place a refused key write can be seen: dsh's own error line is
      // React's, so this is a node of this bundle's own, put under the key field
      // and taken away again on the next attempt.
      const CARD_FAILURE_ATTR = 'data-kenari-card-failure'

      function clearCardFailure(card) {
        if (card === null || card === undefined || typeof card.querySelector !== 'function') return
        const shown = card.querySelector(`[${CARD_FAILURE_ATTR}]`)
        if (shown !== null && shown !== undefined && typeof shown.remove === 'function') shown.remove()
      }

      function showCardFailure(card, message) {
        if (card === null || card === undefined || typeof card.querySelector !== 'function') return
        clearCardFailure(card)
        if (typeof document.createElement !== 'function') return
        const line = document.createElement('p')
        line.setAttribute(CARD_FAILURE_ATTR, '')
        line.setAttribute('style', 'margin:6px 0 0;font-size:12px;color:#d4380d')
        line.textContent = message
        const input = keyInputOf(card)
        const field = input === null ? null : input.parentElement
        if (field !== null && field !== undefined && typeof field.appendChild === 'function') field.appendChild(line)
      }

      const injected = () => ({ scope, loadModels, describeKey })
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          // `locale: NS` is what mints the props `t` seat and makes a missing
          // locale face fail loudly instead of silently painting raw keys. This
          // bundle reads its copy through the module-bound translator instead,
          // which reads the active locale at call time — the outlet's own
          // locale-revision subscription is what re-renders the switch.
          { name: 'settings.section', id: NS, order: 30, label: () => t('nav'), locale: NS, inject: injected },
          KenariSection,
        ),
      )

      // The Models-page seat: dsh declares this slot for exactly this purpose
      // ("a plugin distributed outside this repository adds UI to the Models
      // settings section without editing it"), keyed by the owning settings
      // namespace. The component narrows it to the Kenari route and doubles as
      // the anchor and renderer for the 模型目录 takeover below.
      ctx.slots.inject('settings.models.provider-card', () =>
        ctx.slots.register(
          {
            name: 'settings.models.provider-card',
            key: PI_AI_NS,
            locale: NS,
            inject: () => ({ loadPanel, addModels }),
          },
          ModelPickerHost,
        ),
      )

      // The dictionary for this bundle's own copy. Registered as an effect so a
      // reload cannot leave a stale table behind, exactly like dsh's own plugins.
      ctx.effect(() => ctx.locale.register(NS, LOCALES), 'kenari: 界面文案字典')

      // One document-level listener, torn down with this fiber. It is inert
      // until the Kenari card mounts, because a click only means anything when
      // this plugin's dialog can answer it.
      ctx.effect(() => installEntryTakeover({
        onRemove: (card, modelId) => { cardEdit(card, { removal: modelId }) },
        onReset: (card) => { cardEdit(card, { reset: true }) },
        onField: onCardField,
        onKey: onCardKey,
      }), 'kenari: 模型目录入口接管')
      ensureDialogWidth()

      // The settings nav glyph. dsh picks its own by section id, so this is the
      // only way a plugin can carry its own mark into that rail.
      ctx.effect(() => installSettingsNavIcon(), 'kenari: 设置导航图标')
    }

    exports.NS = NS
    exports.inject = inject
    exports.apply = apply
    // The build gate (scripts/check-client.mjs) drives the pure logic directly:
    // filters, plan coverage, and the route read/write shapes are where a
    // regression is silent in the browser.
    exports.__internals = {
      CAPABILITY_TAGS,
      TAKEOVER_LABELS,
      EDIT_LABELS,
      MODEL_ID_LABELS,
      REMOVE_LABELS,
      SUBMIT_LABELS,
      CANCEL_LABELS,
      RESET_LABELS,
      UNSET,
      fieldTargetOf,
      capacityOf,
      patchModels,
      footerOf,
      syncFooterVisibility,
      scrollMarksOf,
      restoreScroll,
      isRemoveLabel,
      removalRowOf,
      withoutModel,
      refreshProviderEditor,
      cardModelIds,
      revealFoldOf,
      isTakeoverLabel,
      MARKER_ATTR,
      pathGet,
      routeModelsOf,
      planCovered,
      matchesFilters,
      toggleFilter,
      derivePanel,
      markedCard,
      cardWithMarker,
      ModelCatalogModal,
      // Localization and the folded groups: a key with no translation, or a
      // "collapsed" block that opens by default, is invisible until a user
      // notices. The gate asserts both.
      LOCALES,
      LOCALE_NS: NS,
      LOCALE_SPECS,
      ADVANCED_FIELDS,
      KEY_REFERENCE_FIELD,
      TOOL_ONLY_FACTS,
      MODEL_PREVIEW_COUNT,
      visibleModels,
      withDisplayNames,
      formatContextWindow,
      tagLabel,
      Disclosure,
      ReadOnlyRow,
      NAV_ICON_ATTR,
      NAV_ICON_STYLE_ATTR,
      NAV_ICON_URL,
      NAV_ROW_SELECTOR,
      SETTINGS_SECTION_LABEL,
      navIconRule,
      settingsNavButton,
      markNavRow,
    }
    return module.exports
  },
})
