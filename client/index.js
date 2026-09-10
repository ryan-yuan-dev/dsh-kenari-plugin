/**
 * Kenari settings section — browser half.
 *
 * This file is checked in already wrapped in the client module loader's
 * factory format instead of being produced by a bundler: this package builds
 * with plain `tsc`, and the loader only requires that
 * `exports["./client"]` be a file that calls `window.__ModuleLoader__.load`.
 * `scripts/check-client.mjs` runs on every build and executes this factory
 * against a stub React, so a change that breaks the format or reaches for an
 * undeclared module fails the build rather than the browser.
 *
 * Only `react` (a `PLATFORM_MODULES` baseline module) is required at runtime.
 * Everything the card shows comes from services on the client context:
 * `settingsScope` (this plugin's own settings namespace) and `remote.llm`
 * (adapter-discovered models).
 *
 * What deliberately is NOT here: wallet balance, spend totals, and live
 * catalog prices. Those live behind the Host on endpoints with no Remote
 * namespace, and this plugin does not add one — inventing a new Host API
 * package would mean touching dsh beyond a bundle. The card therefore points
 * at the tools that do have them (`kenari_billing`, `kenari_balance`,
 * `kenari_list_models`) instead of showing a number it cannot refresh.
 */

window.__ModuleLoader__.load({
  id: 'dsh-kenari-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Must match the Host-side `KENARI_SETTINGS_NAMESPACE`. */
    const NS = 'kenari'

    /** Scalar fields the Host reads live, so an edit applies at the next operation. */
    const LIVE_FIELDS = [
      { field: 'baseURL', label: 'API base URL', kind: 'string', hint: '[OI]/Responses 线为 https://kenari.id/v1；Anthropic 线为 https://kenari.id（不带 /v1）。形状错误会返回 405。' },
      { field: 'apiKeyEnv', label: '凭据引用名', kind: 'string', hint: '环境变量名，例如 KENARI_API_KEY。key 的值只存在于凭据存储或进程环境里。' },
      { field: 'timeoutMs', label: '单次请求超时（毫秒）', kind: 'number' },
      { field: 'generationTimeoutMs', label: '生成类超时（毫秒）', kind: 'number', hint: '图像/视频/OCR 等按次计费的调用；超时后不自动重试，避免重复扣费。' },
      { field: 'maxRetries', label: '瞬时失败重试次数', kind: 'number', hint: '仅对 429/408/5xx 与网络错误生效。' },
      { field: 'catalogCacheTtlMs', label: '模型目录缓存 TTL（毫秒）', kind: 'number' },
      { field: 'docsCacheTtlMs', label: '文档缓存 TTL（毫秒）', kind: 'number' },
      { field: 'balanceCacheTtlMs', label: '余额缓存 TTL（毫秒）', kind: 'number' },
      { field: 'lowBalanceAlertRp', label: '余额告警阈值（Rp，0 关闭）', kind: 'number' },
    ]

    /** Fields fixed when the plugin loads: the provider/ledger wiring they decide. */
    const RESTART_FIELDS = [
      { field: 'searchEnabled', label: '注册 Kenari 搜索 provider' },
      { field: 'fetchEnabled', label: '注册 Kenari 抓取 provider' },
      { field: 'fallbackEnabled', label: '调用失败时回退 dsh 默认 provider' },
      { field: 'toolsEnabled', label: '注册 kenari_* REST 工具' },
      { field: 'budgetCapRp', label: '会话预算封顶（Rp，0 不封顶）' },
      { field: 'nativeAdapterEnabled', label: '启用插件自带的 Kenari LlmAdapter' },
      { field: 'nativeProviderId', label: '自带 adapter 的 provider 路由名' },
    ]

    /** Facts that need a Host endpoint the plugin does not own; the tools carry them. */
    const TOOL_ONLY_FACTS = [
      ['钱包余额与用量', 'kenari_balance / kenari_usage（走 Kenari MCP，需自己账号的 key）'],
      ['本次会话计费统计与预算', 'kenari_billing'],
      ['模型目录、上下文窗口与实时价格', 'kenari_list_models'],
      ['输入 token 与窗口占比', 'kenari_count_tokens'],
    ]

    const styles = {
      root: { display: 'flex', flexDirection: 'column', gap: '18px', fontSize: '13px', lineHeight: 1.6 },
      title: { margin: 0, fontSize: '15px', fontWeight: 600 },
      lead: { margin: 0, opacity: 0.75 },
      block: { border: '1px solid rgba(127,127,127,0.28)', borderRadius: '8px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' },
      blockTitle: { margin: 0, fontSize: '13px', fontWeight: 600 },
      row: { display: 'grid', gridTemplateColumns: 'minmax(160px, 260px) 1fr', gap: '8px 12px', alignItems: 'center' },
      label: { opacity: 0.85 },
      hint: { gridColumn: '2 / 3', opacity: 0.6, fontSize: '12px', marginTop: '-4px' },
      input: { width: '100%', boxSizing: 'border-box', padding: '4px 8px', border: '1px solid rgba(127,127,127,0.4)', borderRadius: '6px', background: 'transparent', color: 'inherit', font: 'inherit' },
      checkboxRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      badge: { display: 'inline-block', padding: '1px 7px', borderRadius: '999px', border: '1px solid rgba(127,127,127,0.4)', fontSize: '11px', opacity: 0.85 },
      table: { width: '100%', borderCollapse: 'collapse' },
      cell: { textAlign: 'left', padding: '3px 6px', borderBottom: '1px solid rgba(127,127,127,0.18)', verticalAlign: 'top' },
      notice: { margin: 0, opacity: 0.7, fontSize: '12px' },
      error: { margin: 0, color: '#c0392b', fontSize: '12px' },
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
    function LiveField(props) {
      const { spec, committed, overridden, writable, onWrite } = props
      const [draft, setDraft] = React.useState(String(committed ?? ''))
      const [status, setStatus] = React.useState('idle')
      React.useEffect(() => {
        setDraft(String(committed ?? ''))
      }, [committed])

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
          spec.label,
          overridden ? React.createElement('span', { style: { ...styles.badge, marginLeft: '8px' } }, '已覆盖') : null,
          status === 'saved' ? React.createElement('span', { style: { ...styles.badge, marginLeft: '8px' } }, '已保存') : null,
          status === 'invalid' ? React.createElement('span', { style: { ...styles.error, marginLeft: '8px' } }, '不是合法数字') : null,
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
        spec.hint ? React.createElement('div', { style: styles.hint }, spec.hint) : null,
      )
    }

    /** One load-time boolean, rendered read-only with its restart caveat. */
    function RestartField(props) {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('div', { style: styles.label }, props.spec.label),
        React.createElement(
          'div',
          { style: styles.checkboxRow },
          React.createElement('code', { style: styles.mono }, String(props.value)),
          React.createElement('span', { style: styles.badge }, '重启后生效'),
        ),
      )
    }

    /** Adapter-discovered models for this route: names and capacities, no prices. */
    function ModelList(props) {
      const { loadModels } = props
      const [state, setState] = React.useState({ status: 'loading' })
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

      if (state.status === 'loading') return React.createElement('p', { style: styles.notice }, '正在读取模型…')
      if (state.status === 'error') {
        return React.createElement('p', { style: styles.error }, `模型列表读取失败：${state.message}`)
      }
      if (state.models.length === 0) {
        return React.createElement('p', { style: styles.notice }, '该路由没有已注册的模型。检查 llm-pi-ai 预设是否随插件层生效（dsh --profile <p> --dump-config）。')
      }
      return React.createElement(
        React.Fragment,
        null,
        React.createElement('p', { style: styles.notice }, `路由 ${state.route} 自述 ${state.models.length} 个模型：`),
        React.createElement(
          'table',
          { style: styles.table },
          React.createElement(
            'tbody',
            null,
            state.models.map((model) =>
              React.createElement(
                'tr',
                { key: model.id },
                React.createElement('td', { style: styles.cell }, React.createElement('code', { style: styles.mono }, model.id)),
                React.createElement('td', { style: styles.cell }, model.name || ''),
                React.createElement('td', { style: { ...styles.cell, whiteSpace: 'nowrap' } }, model.contextWindow ? `ctx ${model.contextWindow}` : ''),
              ),
            ),
          ),
        ),
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

      if (state.status === 'loading') return React.createElement('span', { style: styles.notice }, '查询中…')
      if (state.status === 'error') return React.createElement('span', { style: styles.error }, `状态查询失败：${state.message}`)
      const info = state.info
      if (info === undefined) return React.createElement('span', { style: styles.error }, '凭据层没有该引用')
      return React.createElement(
        'span',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
        React.createElement('span', { style: styles.badge }, info.configured ? '已配置' : '未配置'),
        info.source ? React.createElement('span', { style: styles.badge }, `来源 ${info.source}`) : null,
        React.createElement('span', { style: styles.badge }, info.writable ? '凭据层可写' : '凭据层只读'),
        info.writable === false
          ? React.createElement('span', { style: styles.notice }, '（进程环境提供的引用由环境遮蔽，凭据层拒绝写入）')
          : null,
      )
    }

    /** The Kenari settings page. */
    function KenariSection(props) {
      const { scope, loadModels, describeKey } = props
      const snapshot = useScopeSnapshot(scope)
      const value = snapshot.value || {}
      // A field's PRESENCE in the raw user layer is what marks it overridden —
      // an override equal to the composition default is still an override.
      const user = snapshot.user || {}
      const writable = snapshot.writable === true

      const write = (field, next) => scope.set(field, next)

      const statusLine = snapshot.status === 'ready'
        ? `已连接设置文档（${snapshot.mode === 'host' ? 'Host 持久化' : '进程内'}）`
        : snapshot.status === 'loading' ? '正在读取设置…' : '设置文档不可用：改动只能在 cordis 配置里做'

      const keyRef = value.apiKeyEnv || '（未设置）'

      return React.createElement(
        'div',
        { style: styles.root },
        React.createElement('h3', { style: styles.title }, 'Kenari'),
        React.createElement('p', { style: styles.lead }, '把 kenari.id 接成 dsh 的会话模型、web 搜索/抓取 provider 与 REST 工具族。'),

        React.createElement(
          'div',
          { style: styles.block },
          React.createElement('h4', { style: styles.blockTitle }, '凭据状态'),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('div', { style: styles.label }, '凭据引用'),
            React.createElement('code', { style: styles.mono }, keyRef),
          ),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('div', { style: styles.label }, '凭据层'),
            React.createElement(KeyStatus, { describeKey, keyRef }),
          ),
          React.createElement(
            'div',
            { style: styles.row },
            React.createElement('div', { style: styles.label }, '设置文档'),
            React.createElement('div', null, writable ? React.createElement('span', { style: styles.badge }, '可写') : React.createElement('span', { style: styles.badge }, '只读')),
          ),
          React.createElement(
            'p',
            { style: styles.notice },
            '这里只显示引用名与状态。key 的值由 dsh 凭据层持有，接口本身没有承载值的字段——任何界面都不会、也不能显示明文。',
          ),
        ),

        React.createElement(
          'div',
          { style: styles.block },
          React.createElement('h4', { style: styles.blockTitle }, '运行参数（提交后下一次操作生效）'),
          React.createElement('p', { style: styles.notice }, statusLine),
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
            LIVE_FIELDS.map((spec) =>
              React.createElement(LiveField, {
                key: spec.field,
                spec,
                committed: value[spec.field],
                overridden: Object.prototype.hasOwnProperty.call(user, spec.field),
                writable,
                onWrite: write,
              }),
            ),
          ),
        ),

        React.createElement(
          'div',
          { style: styles.block },
          React.createElement('h4', { style: styles.blockTitle }, '加载期开关（改动需重启 dsh）'),
          React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            RESTART_FIELDS.map((spec) => React.createElement(RestartField, { key: spec.field, spec, value: value[spec.field] })),
          ),
        ),

        React.createElement(
          'div',
          { style: styles.block },
          React.createElement('h4', { style: styles.blockTitle }, '模型路由'),
          React.createElement(ModelList, { loadModels }),
          React.createElement(
            'p',
            { style: styles.notice },
            '列表来自 adapter 的自述目录。价格与完整目录（含 embedding / rerank / moderation）用 kenari_list_models 查。',
          ),
        ),

        React.createElement(
          'div',
          { style: styles.block },
          React.createElement('h4', { style: styles.blockTitle }, '这些数据在工具里，不在这个页面'),
          React.createElement(
            'table',
            { style: styles.table },
            React.createElement(
              'tbody',
              null,
              TOOL_ONLY_FACTS.map(([what, how]) =>
                React.createElement(
                  'tr',
                  { key: what },
                  React.createElement('td', { style: styles.cell }, what),
                  React.createElement('td', { style: styles.cell }, React.createElement('code', { style: styles.mono }, how)),
                ),
              ),
            ),
          ),
          React.createElement(
            'p',
            { style: styles.notice },
            '余额、计费与实时价格由 Host 侧端点提供，而 dsh 没有对应的 Remote 命名空间；本插件不新增 Host API 包（那需要改 dsh），所以这里不显示会过期的数字。',
          ),
        ),
      )
    }

    /** Services this bundle needs: the slot ledger, the Remotes, and our settings scope. */
    const inject = ['slots', 'remote', 'remote.llm', 'remote.credentials', 'settingsScope']

    /**
     * Register the Kenari settings page once the shell has declared
     * `settings.section` (a registration before that declaration throws).
     */
    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NS })

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
          failures.push(`${candidate.request.provider}: ${result.ok ? '目录为空' : result.error.code}`)
        }
        throw new Error(`没有可用的 Kenari 模型路由（${failures.join('；')}）`)
      }

      /** `describe()` is the only key reader: it answers state, never the value. */
      const describeKey = async (keyRef) => {
        const result = await ctx.remote.credentials.describe([keyRef])
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        return result.value[keyRef]
      }

      const injected = () => ({ scope, loadModels, describeKey })
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: NS, order: 30, label: () => 'Kenari', inject: injected },
          KenariSection,
        ),
      )
    }

    exports.NS = NS
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
