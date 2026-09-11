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
 *
 * The model browser area (`settings.models.provider-card`) is the one place
 * that does read Host-computed data, and it does so through the plugin's own
 * same-origin Fetch route rather than a Remote namespace: dsh's Connection
 * service lets a Host plugin register `/api/...` routes, so the browser reads
 * `/api/kenari.models` with the same session that already authenticates the
 * Remote calls. Capability tags, plan coverage, and every filter are computed
 * Host-side from the public catalog and the plan table — the browser never
 * parses Kenari's payloads itself, so the tags here and `kenari_list_models`
 * can never disagree.
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
      toolbar: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' },
      chip: { padding: '2px 9px', borderRadius: '999px', border: '1px solid rgba(127,127,127,0.4)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer' },
      chipOn: { padding: '2px 9px', borderRadius: '999px', border: '1px solid currentColor', background: 'rgba(127,127,127,0.18)', color: 'inherit', font: 'inherit', fontSize: '12px', cursor: 'pointer', fontWeight: 600 },
      search: { flex: '1 1 160px', minWidth: '120px', boxSizing: 'border-box', padding: '3px 8px', border: '1px solid rgba(127,127,127,0.4)', borderRadius: '6px', background: 'transparent', color: 'inherit', font: 'inherit' },
      // Every tag renders through this one style — capabilities, 免费 and 套餐内
      // alike — so a row reads as a set of equal facts rather than one badge
      // shouting louder than the rest. They never shrink: a squeezed badge is
      // unreadable, and the row wraps instead, keeping every tag at full width.
      capTag: { display: 'inline-block', flexShrink: 0, whiteSpace: 'nowrap', padding: '0 6px', borderRadius: '4px', border: '1px solid rgba(127,127,127,0.35)', fontSize: '11px', opacity: 0.85 },
      list: { maxHeight: '320px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px', border: '1px solid rgba(127,127,127,0.18)', borderRadius: '6px', padding: '6px 8px' },
      // The id heads the line and never shrinks; the tags follow it and wrap
      // as a group when the row runs out of width.
      item: { display: 'flex', flexWrap: 'wrap', gap: '2px 8px', alignItems: 'center', padding: '3px 0' },
      itemId: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'nowrap', flexShrink: 0 },
      dim: { opacity: 0.45, fontSize: '12px', whiteSpace: 'nowrap', flexShrink: 0 },
      primary: { alignSelf: 'flex-start', padding: '4px 12px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.5)', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' },
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
     * The optional-models browser: the same catalog the tools see, with the
     * capability and plan dimensions surfaced as tags and as filters.
     *
     * `allowAdd` is what separates the two seats. On the Kenari settings card
     * the panel is a browser only (the route is edited on the Models page); on
     * the Models page it can write the selected models into the route's
     * profile, extending the array instead of replacing it.
     */
    function CatalogBrowser(props) {
      const { allowAdd, routeNs, routeProvider, loadPanel, addModels } = props
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
        const route = allowAdd && routeNs !== undefined && routeProvider !== undefined
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
      }, [loadPanel, reloads, allowAdd, routeNs, routeProvider])

      if (state.status === 'loading') return React.createElement('p', { style: styles.notice }, '正在读取模型目录…')
      if (state.status === 'error') {
        return React.createElement('p', { style: styles.error }, `模型目录读取失败：${state.message}`)
      }

      const view = state.panel.view
      const routeState = state.panel.route
      const tags = Array.isArray(view.tags) && view.tags.length > 0 ? view.tags : CAPABILITY_TAGS
      const models = view.models || []
      const known = {}
      for (const id of (routeState && routeState.modelIds) || []) known[id] = true

      const visible = models.filter((model) => matchesFilters(model, query.trim(), flags))
      const visibleIds = visible.map((model) => model.id)
      const selectedVisible = visibleIds.filter((id) => picked.indexOf(id) !== -1)
      const allVisiblePicked = visibleIds.length > 0 && selectedVisible.length === visibleIds.length
      const addable = visible.filter((model) => known[model.id] !== true && picked.indexOf(model.id) !== -1)

      const toggleFlag = (tag) => {
        setFlags((current) => {
          const next = { ...current }
          if (next[tag] === true) delete next[tag]
          else next[tag] = true
          return next
        })
      }
      const togglePick = (id) => {
        setPicked((current) => current.indexOf(id) === -1
          ? current.concat([id])
          : current.filter((entry) => entry !== id))
      }
      const toggleVisible = () => {
        setPicked((current) => allVisiblePicked
          ? current.filter((id) => visibleIds.indexOf(id) === -1)
          : current.concat(visibleIds.filter((id) => current.indexOf(id) === -1)))
      }
      const clearFilters = () => {
        setQuery('')
        setFlags({})
      }

      const submit = () => {
        const profiles = addable.map((model) => model.profile)
        if (profiles.length === 0 || routeNs === undefined || routeProvider === undefined) return
        setWrite({ status: 'saving' })
        addModels({ settingsNs: routeNs, provider: routeProvider }, profiles).then(
          (result) => {
            setWrite(result.ok === true
              ? { status: 'added', message: `已加入 ${profiles.length} 个模型` }
              : { status: 'error', message: result.message })
            if (result.ok === true) {
              setPicked([])
              setReloads((current) => current + 1)
            }
          },
          (err) => setWrite({ status: 'error', message: String(err && err.message ? err.message : err) }),
        )
      }

      // Every dimension is one chip of the same kind: plan, free, then the
      // capability tags. No plan NAMES appear anywhere — a reader filtering by
      // subscription wants "covered by a plan", not a pick-one-of-five tier.
      const filterChips = ['plan', 'free'].concat(tags).map((tag) => React.createElement(
        'button',
        {
          key: tag,
          type: 'button',
          style: flags[tag] === true ? styles.chipOn : styles.chip,
          'aria-pressed': flags[tag] === true,
          onClick: () => { toggleFlag(tag) },
        },
        tag === 'plan' ? '套餐内' : tag === 'free' ? '免费' : tag,
      ))

      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'div',
          { style: styles.toolbar },
          React.createElement('input', {
            style: styles.search,
            type: 'search',
            value: query,
            placeholder: '搜索 id / 名称 / 厂商',
            'aria-label': '搜索模型',
            onChange: (event) => { setQuery(event.target.value) },
          }),
          filterChips,
          React.createElement('button', { type: 'button', style: styles.chip, onClick: clearFilters }, '清除筛选'),
        ),
        React.createElement(
          'p',
          { style: styles.notice },
          `显示 ${visible.length} / ${models.length} 个模型`
          + (allowAdd ? `，已选 ${addable.length} 个待加入` : '')
          + `。能力标签按目录事实推导；「套餐内」= 付费模型被某个订阅套餐覆盖（请求从套餐额度扣费）；免费模型不标注，没有这个标签的付费模型只能用余额（PAYG）。`,
        ),
        view.plansError !== undefined
          ? React.createElement('p', { style: styles.error }, `套餐表读取失败，「套餐内」标签与筛选本次不可用：${view.plansError}`)
          : null,
        visible.length === 0
          ? React.createElement('p', { style: styles.notice }, '当前筛选下没有模型。')
          : React.createElement(
            'div',
            { style: styles.list },
            visible.map((model) => React.createElement(
              'label',
              { key: model.id, style: styles.item },
              allowAdd && known[model.id] !== true
                ? React.createElement('input', {
                  type: 'checkbox',
                  checked: picked.indexOf(model.id) !== -1,
                  onChange: () => { togglePick(model.id) },
                })
                : React.createElement('span', { style: { width: '13px' } }, known[model.id] === true ? '✓' : ''),
              // The id alone: it is the exact string a request and the route
              // entry use, and the vendor's display name beside it only made
              // every row wider without adding anything a reader acts on. The
              // name still travels in the payload (search matches it, and it
              // is what gets written into the route's model entry).
              React.createElement('code', { style: styles.itemId }, model.id),
              model.free === true ? React.createElement('span', { style: styles.capTag }, '免费') : null,
              (model.tags || []).map((tag) => React.createElement('span', { key: tag, style: styles.capTag }, tag)),
              // One boolean tag, never one badge per plan: the only question a
              // row answers is "does a subscription cover this PAID model", and
              // the tier that happens to cover it is not the reader's business.
              planCovered(model) ? React.createElement('span', { style: styles.capTag }, '套餐内') : null,
              model.chatCapable === false ? React.createElement('span', { style: styles.dim }, '（非会话模型）') : null,
              known[model.id] === true ? React.createElement('span', { style: styles.dim }, '已在路由') : null,
            )),
          ),
        allowAdd
          ? React.createElement(
            'div',
            { style: styles.toolbar },
            React.createElement('button', { type: 'button', style: styles.chip, onClick: toggleVisible }, allVisiblePicked ? '取消全选' : '全选可见'),
            React.createElement(
              'button',
              {
                type: 'button',
                style: styles.primary,
                disabled: addable.length === 0 || write.status === 'saving',
                onClick: submit,
              },
              write.status === 'saving' ? '正在加入…' : `加入所选到 kenari 路由（${addable.length}）`,
            ),
            routeState !== undefined && routeState.writable === false
              ? React.createElement('span', { style: styles.notice }, '设置文档只读，不能写入。')
              : null,
            write.status === 'added' ? React.createElement('span', { style: styles.badge }, write.message) : null,
            write.status === 'error' ? React.createElement('span', { style: styles.error }, write.message) : null,
          )
          : null,
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
      const { scope, loadModels, describeKey, loadPanel } = props
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
          React.createElement('h4', { style: styles.blockTitle }, '可选模型（能力 / 套餐筛选）'),
          React.createElement(CatalogBrowser, { allowAdd: false, loadPanel }),
          React.createElement(
            'p',
            { style: styles.notice },
            '目录、能力标签与套餐归属都由 Host 侧组装（公开目录 + 套餐表），所以没配 key 也能看。要在路由里增删模型请去「设置 → 模型 → Kenari → 编辑」。',
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
    const inject = ['slots', 'remote', 'remote.llm', 'remote.credentials', 'remote.settings', 'settingsScope']

    /** The provider-card extension seat's registrant: our panel, for pi-ai routes only. */
    function ProviderCardCatalog(props) {
      // The seat dispatches for every route the pi-ai namespace owns; this
      // panel is about Kenari, so another pi-ai route renders nothing.
      if (props.provider === undefined || props.provider.provider !== 'kenari') return null
      return React.createElement('div', { style: styles.block },
        React.createElement('h4', { style: styles.blockTitle }, 'Kenari 可选模型（能力 / 套餐筛选）'),
        React.createElement(CatalogBrowser, {
          allowAdd: true,
          routeNs: PI_AI_NS,
          routeProvider: props.provider.provider,
          loadPanel: props.loadPanel,
          addModels: props.addModels,
        }),
        React.createElement(
          'p',
          { style: styles.notice },
          '这是 dsh「获取可用模型」的能力/套餐扩展：勾选后写入该路由的模型数组（在现有列表后追加，不覆盖）。'
          + 'dsh 自带的那个对话框由 dsh 自己渲染，只显示模型 id，插件无法往里加标签或过滤器。',
        ),
      )
    }

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
        if (read.view === undefined) return { ok: false, message: `设置文档里没有 ${PI_AI_NS} 命名空间` }
        if (read.writable !== true) return { ok: false, message: '设置文档只读，改动只能在 cordis 配置里做' }
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

      const injected = () => ({ scope, loadModels, describeKey, loadPanel })
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: NS, order: 30, label: () => 'Kenari', inject: injected },
          KenariSection,
        ),
      )

      // The Models-page seat: dsh declares this slot for exactly this purpose
      // ("a plugin distributed outside this repository adds UI to the Models
      // settings section without editing it"), keyed by the owning settings
      // namespace. Only the pi-ai route needs it, and the component narrows
      // further to Kenari.
      ctx.slots.inject('settings.models.provider-card', () =>
        ctx.slots.register(
          {
            name: 'settings.models.provider-card',
            key: PI_AI_NS,
            inject: () => ({ loadPanel, addModels }),
          },
          ProviderCardCatalog,
        ),
      )
    }

    exports.NS = NS
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
