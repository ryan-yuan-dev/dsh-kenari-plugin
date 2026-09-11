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
 * Entry point: the Models page's 获取可用模型 button, on the Kenari card only.
 * dsh renders that button itself and offers no slot inside its dialog — adding
 * fields there would mean editing dsh, which this plugin never does. What a
 * plugin CAN own is the entry point, so `installFetchTakeover` recognizes that
 * one button in the card this bundle's slot renders into and opens this
 * plugin's picker instead. Every branch fails open, so the native flow is
 * still there wherever the takeover does not apply.
 */

window.__ModuleLoader__.load({
  id: 'dsh-kenari-plugin',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { Modal, Button, Pill, Tag } = require('@deepseek-ai/dsh-client-ui-primitives')

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
     * Marks the Kenari card in the DOM. The Models-page component renders it
     * into the same card element dsh renders that card's editor into, which is
     * what lets the click takeover tell "the 获取可用模型 button on the Kenari
     * card" from the identical button every other provider's editor renders.
     */
    const MARKER_ATTR = 'data-kenari-model-picker'

    /**
     * The label dsh's own 获取可用模型 button carries, in the locales this
     * build ships. Text is the only stable identity that button has: its class
     * is a CSS-module hash, and its position among its siblings varies with
     * whether the 重置模型目录 link is rendered beside it.
     */
    const FETCH_LABELS = ['获取可用模型', 'Fetch available models']

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

    /**
     * The selection box every row starts with, in both of its forms: a real
     * checkbox on a row you can add, and the ✓ marker on a row already in the
     * route. A native checkbox carries browser margin and its own intrinsic
     * size, so a plain span around the ✓ lined up with nothing — both forms get
     * this exact box, which is what keeps the ✓ and the checkboxes in one column.
     */
    const PICK_BOX = { width: '14px', height: '14px', flexShrink: 0, margin: 0, boxSizing: 'border-box' }

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
      pickBox: PICK_BOX,
      pickMark: { ...PICK_BOX, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', lineHeight: 1, opacity: 0.75 },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      badge: { display: 'inline-block', padding: '1px 7px', borderRadius: '999px', border: '1px solid rgba(127,127,127,0.4)', fontSize: '11px', opacity: 0.85 },
      table: { width: '100%', borderCollapse: 'collapse' },
      cell: { textAlign: 'left', padding: '3px 6px', borderBottom: '1px solid rgba(127,127,127,0.18)', verticalAlign: 'top' },
      notice: { margin: 0, opacity: 0.7, fontSize: '12px' },
      error: { margin: 0, color: '#c0392b', fontSize: '12px' },
      toolbar: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' },
      filterRow: { display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' },
      // The search box is the one control dsh's Input atom cannot carry here:
      // that atom wraps the field in a fixed-height inline-flex box whose width
      // comes from a class this bundle cannot pass, so the field would size to
      // its placeholder. Styling the bare input with dsh's own tokens keeps the
      // look while leaving `flex` — the thing this layout needs — to inline style.
      search: { flex: '1 1 200px', minWidth: '140px', boxSizing: 'border-box', height: '32px', padding: '0 8px', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: '8px', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: '14px' },
      // The list scrolls inside the dialog: the picker must never push its own
      // footer off screen, because that footer is where 添加所选 lives.
      list: { maxHeight: 'min(52vh, 420px)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px', border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: '8px', padding: '6px 8px' },
      // The row is one non-wrapping band: checkbox, id, then the tag column.
      // `alignItems: center` therefore centers the id against the tag block,
      // and the tags wrap inside their own column instead of restarting at the
      // row's left edge.
      item: { display: 'flex', flexWrap: 'nowrap', gap: '8px', alignItems: 'center', padding: '3px 0', cursor: 'default' },
      itemId: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'nowrap', flexShrink: 0 },
      tagColumn: { display: 'flex', flexWrap: 'wrap', gap: '2px 6px', alignItems: 'center', flex: '1 1 auto', minWidth: 0 },
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

    /** The nearest ancestor of `start` that contains this card's marker. */
    function cardWithMarker(start) {
      let node = start.parentElement
      while (node !== null && node.ownerDocument !== null && node !== node.ownerDocument.body) {
        if (typeof node.querySelector === 'function' && node.querySelector(`[${MARKER_ATTR}]`) !== null) return node
        node = node.parentElement
      }
      return null
    }

    /**
     * Take over the Kenari card's 获取可用模型 button.
     *
     * A capture-phase listener on the document runs before React's
     * root-container listener, so `stopPropagation` here keeps dsh's own click
     * handler from ever seeing the event. The match is deliberately narrow: the
     * label is dsh's own, and the button must sit in a card containing this
     * bundle's marker. Everything else — another provider's identical button, a
     * click inside this plugin's own dialog (which is portaled to `body`, so no
     * marker is above it), a click this plugin originated — propagates
     * untouched, which is what keeps the native dialog reachable.
     */
    function installFetchTakeover() {
      const onClickCapture = (event) => {
        if (takeoverBypassed || !pickerChannel.mounted) return
        const target = event.target
        if (target === null || target === undefined || typeof target.closest !== 'function') return
        const button = target.closest('button')
        if (button === null) return
        const label = typeof button.textContent === 'string' ? button.textContent.trim() : ''
        if (FETCH_LABELS.indexOf(label) === -1) return
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
     * Everything the catalog shows and does, in one hook feeding both entry
     * points (the taken-over native button and the Kenari settings page), so a
     * filter or a write behaves identically wherever the reader opened it.
     */
    function useCatalogPanel(props) {
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

      const view = state.status === 'ready' ? state.panel.view : {}
      const routeState = state.status === 'ready' ? state.panel.route : undefined
      const derived = derivePanel(view, routeState, query, flags, picked)

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
              ? {
                status: 'added',
                message: `已加入 ${String(profiles.length)} 个模型到 kenari 路由（立即生效，不需要再点「保存」）。`
                  + '卡片里那份模型列表是编辑器的草稿，要收起再展开「编辑」才会刷新。',
              }
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

    /** The search box, the filter chips, and the select-all control. */
    function CatalogToolbar(props) {
      const { panel } = props
      // Every dimension is one chip of the same kind: plan, free, then the
      // capability tags. No plan NAMES appear anywhere — a reader filtering by
      // subscription wants "covered by a plan", not a pick-one-of-five tier.
      const chips = ['plan', 'free'].concat(panel.derived.tags).map((tag) => React.createElement(
        Pill,
        {
          key: tag,
          active: panel.flags[tag] === true,
          'aria-pressed': panel.flags[tag] === true,
          onClick: () => {
            panel.toggleFlag(tag)
          },
        },
        tag === 'plan' ? '套餐内' : tag === 'free' ? '免费' : tag,
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
            placeholder: '搜索 id / 名称 / 厂商',
            'aria-label': '搜索模型',
            onChange: (event) => {
              panel.setQuery(event.target.value)
            },
          }),
          React.createElement(
            Button,
            { variant: 'ghost', size: 'sm', disabled: panel.derived.visible.length === 0, onClick: panel.toggleVisible },
            panel.derived.allVisiblePicked ? '取消全选' : '全选可见',
          ),
          React.createElement(Button, { variant: 'ghost', size: 'sm', onClick: panel.clearFilters }, '清除筛选'),
        ),
        React.createElement('div', { style: styles.filterRow }, chips),
      )
    }

    /** What the current filter is showing, and what the tags mean. */
    function CatalogSummary(props) {
      const { derived, allowAdd } = props
      return React.createElement(
        'p',
        { style: styles.notice },
        `显示 ${String(derived.visible.length)} / ${String(derived.models.length)} 个模型`
        + (allowAdd ? `，已选 ${String(derived.addable.length)} 个待加入` : '')
        + '。能力标签按目录事实推导；免费模型看 id 的 `:free` 后缀；「套餐内」= 付费模型被某个订阅套餐覆盖（请求从套餐额度扣费），没有这个标签的付费模型只能用余额（PAYG）。',
      )
    }

    /** The model rows: pick box, id, then the tag column. */
    function CatalogRows(props) {
      const { derived, allowAdd, picked, togglePick } = props
      if (derived.visible.length === 0) {
        return React.createElement('p', { style: styles.notice }, '当前筛选下没有模型。')
      }
      return React.createElement(
        'div',
        { style: styles.list },
        derived.visible.map((model) => React.createElement(
          'label',
          { key: model.id, style: styles.item },
          // The pick column exists only where a pick is possible. In the
          // read-only dialog there is no route to check against, so an empty
          // box would be a blank column in front of every row.
          allowAdd
            ? derived.known[model.id] !== true
              ? React.createElement('input', {
                type: 'checkbox',
                style: styles.pickBox,
                checked: picked.indexOf(model.id) !== -1,
                onChange: () => {
                  togglePick(model.id)
                },
              })
              : React.createElement('span', { style: styles.pickMark }, '✓')
            : null,
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
            (model.tags || []).map((tag) => React.createElement(Tag, { key: tag, tone: 'outline' }, tag)),
            // One boolean tag, never one badge per plan: the only question a
            // row answers is "does a subscription cover this PAID model", and
            // the tier that happens to cover it is not the reader's business.
            planCovered(model) ? React.createElement(Tag, { tone: 'outline' }, '套餐内') : null,
            model.chatCapable === false ? React.createElement('span', { style: styles.dim }, '（非会话模型）') : null,
            derived.known[model.id] === true ? React.createElement('span', { style: styles.dim }, '已在路由') : null,
          ),
        )),
      )
    }

    /**
     * The catalog as dsh's own dialog: same Modal chrome, same Button/Pill/Tag
     * tokens as the 获取可用模型 dialog it stands in for, with the capability
     * and plan dimensions added into that one surface.
     *
     * It is mounted only while open (see the two call sites), so a closed dialog
     * costs no request and every opening starts from a fresh query and pick set.
     */
    function ModelCatalogModal(props) {
      const { allowAdd, onClose, nativeButton, loadPanel, addModels, routeNs, routeProvider } = props
      const panel = useCatalogPanel({ allowAdd, routeNs, routeProvider, loadPanel, addModels })

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

      const footer = allowAdd
        ? React.createElement(
          React.Fragment,
          null,
          React.createElement('span', { style: styles.footerNote }, '写入立即生效'),
          React.createElement(Button, { variant: 'outline', onClick: onClose }, '取消'),
          React.createElement(
            Button,
            {
              variant: 'primary',
              disabled: panel.derived.addable.length === 0 || panel.write.status === 'saving',
              onClick: panel.submit,
            },
            panel.write.status === 'saving' ? '正在加入…' : `添加所选（${String(panel.derived.addable.length)}）`,
          ),
        )
        : React.createElement(Button, { variant: 'outline', onClick: onClose }, '关闭')

      const plansError = viewPlansError(panel)
      const body = panel.state.status === 'loading'
        ? React.createElement('p', { style: styles.notice }, '正在读取模型目录…')
        : panel.state.status === 'error'
          ? React.createElement(
            React.Fragment,
            null,
            React.createElement('p', { style: styles.error }, `模型目录读取失败：${panel.state.message}`),
            allowAdd && nativeButton !== undefined
              ? React.createElement('p', { style: { margin: 0 } }, React.createElement(
                Button,
                { variant: 'outline', size: 'sm', onClick: fallbackToNative },
                '改用 dsh 自带对话框',
              ))
              : null,
          )
          : React.createElement(
            React.Fragment,
            null,
            React.createElement(CatalogToolbar, { panel }),
            React.createElement(CatalogSummary, { derived: panel.derived, allowAdd }),
            plansError !== undefined ? React.createElement('p', { style: styles.error }, plansError) : null,
            React.createElement(CatalogRows, { derived: panel.derived, allowAdd, picked: panel.picked, togglePick: panel.togglePick }),
            panel.routeState !== undefined && panel.routeState.writable === false
              ? React.createElement('p', { style: styles.notice }, '设置文档只读，不能写入。')
              : null,
            panel.write.status === 'added' ? React.createElement('p', { style: styles.notice }, panel.write.message) : null,
            panel.write.status === 'error' ? React.createElement('p', { style: styles.error }, panel.write.message) : null,
          )

      return React.createElement(
        Modal,
        {
          open: true,
          onClose,
          title: allowAdd ? '选择要添加的模型' : '可选模型目录',
          closeLabel: '关闭',
          description: allowAdd
            ? 'Kenari 目录的可用模型，按能力与套餐筛选后勾选，点「添加所选」写入 kenari 路由。'
            : '只读浏览。目录、能力标签与套餐归属都由 Host 侧组装（公开目录 + 套餐表），没配 key 也能看。',
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
        : `套餐表读取失败，「套餐内」标签与筛选本次不可用：${String(plansError)}`
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
            allowAdd: true,
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
      const [browsing, setBrowsing] = React.useState(false)

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
            RESTART_FIELDS.map((spec) => React.createElement(RestartField, { key: spec.field, spec: spec, value: value[spec.field] })),
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

        // The same dialog the Models page opens, minus the write: this page is
        // for reading the catalog, and the route is edited where dsh edits it.
        React.createElement(
          'div',
          { style: styles.block },
          React.createElement('h4', { style: styles.blockTitle }, '可选模型目录'),
          React.createElement(
            'p',
            { style: styles.notice },
            '与「设置 → 模型 → Kenari → 编辑 → 获取可用模型」打开的是同一个对话框：目录、能力标签与套餐归属都由 Host 侧组装，没配 key 也能看。',
          ),
          React.createElement(
            Button,
            { variant: 'outline', size: 'sm', onClick: () => { setBrowsing(true) } },
            '浏览可选模型（能力 / 套餐筛选）',
          ),
          browsing
            ? React.createElement(ModelCatalogModal, {
              allowAdd: false,
              onClose: () => { setBrowsing(false) },
              loadPanel,
            })
            : null,
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
      // namespace. The component narrows it to the Kenari route and doubles as
      // the anchor and renderer for the 获取可用模型 takeover below.
      ctx.slots.inject('settings.models.provider-card', () =>
        ctx.slots.register(
          {
            name: 'settings.models.provider-card',
            key: PI_AI_NS,
            inject: () => ({ loadPanel, addModels }),
          },
          ModelPickerHost,
        ),
      )

      // One document-level listener, torn down with this fiber. It is inert
      // until the Kenari card mounts, because a click only means anything when
      // this plugin's dialog can answer it.
      ctx.effect(() => installFetchTakeover(), 'kenari: 获取可用模型 入口接管')
    }

    exports.NS = NS
    exports.inject = inject
    exports.apply = apply
    // The build gate (scripts/check-client.mjs) drives the pure logic directly:
    // filters, plan coverage, and the route read/write shapes are where a
    // regression is silent in the browser.
    exports.__internals = {
      CAPABILITY_TAGS,
      FETCH_LABELS,
      MARKER_ATTR,
      pathGet,
      routeModelsOf,
      planCovered,
      matchesFilters,
      derivePanel,
      cardWithMarker,
      ModelCatalogModal,
    }
    return module.exports
  },
})
