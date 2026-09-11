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
        'models.hint': '这里列出当前路由可用的模型。价格与完整目录（含向量、重排等非会话模型）用 kenari_list_models 查看。',
        'models.context': '上下文 {size}',

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
        'catalog.plansError': '套餐表读取失败，「套餐内」标签与筛选这次不可用：{message}',
        'catalog.empty': '当前筛选下没有模型。',
        'catalog.summary': '显示 {visible} / {total} 个，待加入 {addable} 个。「套餐内」表示这个付费模型由订阅套餐覆盖，否则走余额。',
        'catalog.footerNote': '加入后立即生效',
        'catalog.submit': '添加所选（{count}）',
        'catalog.saving': '正在加入…',
        'catalog.added': '已加入 {count} 个模型。模型页的列表要重新展开「编辑」才会刷新。',
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
        'models.hint': 'These are the models this route can use right now. Use kenari_list_models for pricing and the full catalog, including embedding and rerank models.',
        'models.context': '{size} context',

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
        'catalog.plansError': 'Could not read the plan table, so the "In plan" tag and filter are unavailable this time: {message}',
        'catalog.empty': 'No model matches these filters.',
        'catalog.summary': 'Showing {visible} of {total}, {addable} ready to add. "In plan" means a subscription covers this paid model; otherwise it is billed to your balance.',
        'catalog.footerNote': 'Applies immediately',
        'catalog.submit': 'Add selected ({count})',
        'catalog.saving': 'Adding…',
        'catalog.added': 'Added {count} models. The list on the Models page refreshes once you reopen Edit.',
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
     */
    function installEntryTakeover() {
      const onClickCapture = (event) => {
        if (takeoverBypassed || !pickerChannel.mounted) return
        const target = event.target
        if (target === null || target === undefined || typeof target.closest !== 'function') return
        const button = target.closest('button')
        if (button === null) return
        const label = typeof button.textContent === 'string' ? button.textContent.trim() : ''
        if (!isTakeoverLabel(label)) return
        if (cardWithMarker(button) === null) return
        event.preventDefault()
        event.stopPropagation()
        pickerChannel.open(button)
      }
      document.addEventListener('click', onClickCapture, true)
      return () => {
        document.removeEventListener('click', onClickCapture, true)
      }
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
      const { routeNs, routeProvider, loadPanel, addModels } = props
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
          (result) => {
            setWrite(result.ok === true
              ? { status: 'added', message: t('catalog.added', { count: profiles.length }) }
              : { status: 'error', message: result.message })
            if (result.ok === true) {
              setPicked([])
              setReloads((current) => current + 1)
            }
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
      const panel = useCatalogPanel({ routeNs, routeProvider, loadPanel, addModels })

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
      if (props.provider === undefined || props.provider.provider !== 'kenari') return null
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
                React.createElement('td', { style: { ...styles.cell, whiteSpace: 'nowrap', opacity: 0.7 } }, context === undefined ? '' : t('models.context', { size: context })),
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

      // Bind the translator before anything can render: the components below
      // call it, and every one of them is reachable from here on.
      t = ctx.locale.bind(NS)

      /**
       * Model discovery is per owning settings namespace, and a route pi-ai does
       * not ship also needs the endpoint to ask: `llm-pi-ai` owns the shipped
       * preset route, while the plugin's own adapter (phase 5) owns its route
       * under this plugin's namespace. Try the shipped route first so the card
       * works out of the box, then the native one.
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
            return { route: candidate.request.provider, models: result.value }
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
        const written = await ctx.remote.settings.mutate(
          route.settingsNs,
          [{ op: 'set', path: ['providers', route.provider, 'models'], value: [...byId.values()] }],
          read.view.revision,
        )
        if (!written.ok) return { ok: false, message: `${written.error.code}: ${written.error.message}` }
        return { ok: true }
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
      ctx.effect(() => installEntryTakeover(), 'kenari: 模型目录入口接管')
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
