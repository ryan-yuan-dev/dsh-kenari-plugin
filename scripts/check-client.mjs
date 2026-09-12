/**
 * Build-time gate for the hand-written client bundle.
 *
 * `client/index.js` is not produced by a bundler, so nothing else would catch a
 * syntax error, a wrong registration id, a missing export, or a `require()` of a
 * module the loader's baseline table cannot answer — all of which fail in the
 * browser instead of the build. This executes the file the same way the loader
 * does: it captures the `window.__ModuleLoader__.load` registration, runs the
 * factory against a stub module table, and asserts the resulting module face.
 *
 * It also drives the logic that would otherwise only be exercised by hand in a
 * browser: the filter/plan join behind the picker, and the DOM guard behind the
 * 模型目录 takeover. Both are silent when wrong — a filter that drops the
 * wrong row still renders, and a takeover that matches the wrong button still
 * looks like it worked.
 *
 * Run: node scripts/check-client.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const source = readFileSync(join(root, 'client/index.js'), 'utf8')

const failures = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail === '' ? '' : ` — ${detail}`}`)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

// 1) The loader's baseline module table, as this bundle may use it. Keep in step
//    with dsh's PLATFORM_MODULES; anything else must be declared in dsh.client.external.
const BASELINE = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives',
])
const declaredExternals = new Set(pkg.dsh?.client?.external ?? [])
const requested = []

let registration
// What the bundle appends to `document.head` (the picker's width rule and the
// nav-icon rule), and everything it creates (those two styles plus the probe).
const appendedNodes = []
const createdNodes = []
// The nav-icon installer observes the body for the settings panel and probes the
// favicon route with an <img>. Both are stubbed so `apply` runs for real, and the
// gate can still drive the deferred half — a panel that mounts after the probe
// resolves, which is the only path the browser takes.
const observers = []
class MutationObserverStub {
  constructor(callback) {
    this.callback = callback
    this.target = undefined
    this.disconnected = false
    observers.push(this)
  }
  observe(target) {
    this.target = target
  }
  disconnect() {
    this.disconnected = true
  }
}
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(record) {
        registration = record
      },
    },
  },
  // The takeover installs one capture-phase listener on the document, the two
  // rules are appended to head, and the nav-icon installer observes the body;
  // `apply` needs all three in scope. Nothing here dispatches a real click,
  // loads a real image, or paints anything.
  document: {
    body: { nodeType: 1 },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => {
      const node = {
        tag,
        textContent: '',
        attributes: {},
        setAttribute(name, value) {
          node.attributes[name] = value
        },
      }
      createdNodes.push(node)
      return node
    },
    head: {
      appendChild(node) {
        appendedNodes.push(node)
      },
    },
    addEventListener() {},
    removeEventListener() {},
  },
  MutationObserver: MutationObserverStub,
  setTimeout: (fn) => {
    fn()
    return 0
  },
  console,
  Symbol,
  Object,
  Array,
  Number,
  String,
  Boolean,
  Math,
  JSON,
  Date,
  Error,
  Promise,
  Set,
  Map,
  RegExp,
  isFinite,
  undefined,
}
sandbox.globalThis = sandbox

try {
  vm.runInNewContext(source, sandbox, { filename: 'client/index.js' })
} catch (err) {
  check('client bundle parses and registers', false, String(err))
  process.exit(1)
}

check('client bundle calls window.__ModuleLoader__.load', typeof registration?.factory === 'function')
check('registration id is the package name', registration?.id === pkg.name, `id=${registration?.id} name=${pkg.name}`)

let exports
try {
  exports = registration.factory((specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return stubReact()
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return stubPrimitives()
    if (BASELINE.has(specifier) || declaredExternals.has(specifier)) return {}
    throw new Error(`undeclared module request "${specifier}"`)
  })
} catch (err) {
  check('factory runs against a stub module table', false, String(err))
  process.exit(1)
}

/**
 * A React stub good enough to run one render pass. `useSyncExternalStore`
 * returns a realistic settings snapshot, so the section body executes for real
 * — that is what turns a ReferenceError or a bad prop access into a build
 * failure instead of a silent `data-slot-error` placeholder in the browser.
 */
function stubReact() {
  const element = (type, props, ...children) => ({ $$typeof: Symbol.for('react.element'), type, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } })
  return {
    createElement: element,
    Fragment: Symbol.for('react.fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
}

/**
 * dsh's UI primitives, as the bundle uses them. `Modal` renders its children
 * regardless of `open` so one render pass reaches the dialog body — the point is
 * to execute that body, not to reproduce modal behavior.
 */
function stubPrimitives() {
  const React = stubReact()
  const passthrough = (name) => (props) => React.createElement(name, props, props?.children)
  return {
    Modal: (props) => React.createElement('modal', { title: props.title, onClose: props.onClose }, [props.footer ?? null, props.children ?? null]),
    Button: passthrough('button'),
    Pill: passthrough('pill'),
    Tag: passthrough('tag'),
    Switch: passthrough('switch'),
  }
}

/** Every element in a stub element tree, depth-first. */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  visit(node)
  walk(node.props?.children, visit)
}

/** Whether a stub element tree contains an element satisfying `predicate`. */
function contains(node, predicate) {
  let found = false
  walk(node, (element) => {
    if (predicate(element)) found = true
  })
  return found
}

/**
 * The element tree with every function component invoked once.
 *
 * `walk` only sees host elements: a component element's own copy has no strings
 * in it, so "does the page actually render this row" cannot be asked of the raw
 * tree. Invoking the components flattens them, which is what lets the gate
 * assert where a row lives rather than only that its spec exists. The stub's
 * hooks are inert (`useEffect` never runs its callback), so a component that
 * fetches on mount renders its loading branch — no request leaves the process.
 */
function expand(node) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return { ...node, props: { ...node.props, children: expand(node.props?.children) } }
}

check('factory runs against a stub module table', true)
check('bundle exports apply/inject/NS', typeof exports.apply === 'function' && Array.isArray(exports.inject) && typeof exports.NS === 'string')

// A typo in a service name means the bundle never activates; the browser would
// only show a missing section. Namespaces ride the `remote.` prefix, and the
// bare `remote` service is the registry itself.
const PLAIN_SERVICES = new Set(['slots', 'locale', 'remote', 'settingsScope', 'settingsSchema'])
check(
  'inject lists only real services (remote.* namespaces included)',
  exports.inject.every((name) => PLAIN_SERVICES.has(name) || name.startsWith('remote.')),
  exports.inject.join(', '),
)
check(
  'every required module is baseline or declared',
  requested.every((specifier) => BASELINE.has(specifier) || declaredExternals.has(specifier)),
  requested.join(', '),
)

// The browser half and the Host half join on this string; a mismatch is silent.
const hostSource = readFileSync(join(root, 'src/settings.ts'), 'utf8')
const hostNs = /KENARI_SETTINGS_NAMESPACE = '([^']+)'/.exec(hostSource)?.[1]
check('client NS matches the Host settings namespace', hostNs === exports.NS, `host=${hostNs} client=${exports.NS}`)

// ---------------------------------------------------------------------------
// The picker's logic, with a catalog view shaped like the Host's response.
// ---------------------------------------------------------------------------
const internals = exports.__internals
check('bundle exports the pure internals the gate drives', internals !== undefined && typeof internals === 'object')
if (internals === undefined) {
  console.error('\nclient bundle check failed:\n  __internals missing')
  process.exit(1)
}

const VIEW = {
  tags: ['image', 'audio', 'video', 'pdf', 'embedding'],
  models: [
    { id: 'alpha:free', free: true, tags: ['image'], chatCapable: true, profile: { id: 'alpha:free' } },
    { id: 'beta', free: false, tags: ['image', 'pdf'], plans: ['studio'], chatCapable: true, profile: { id: 'beta' } },
    { id: 'gamma', free: false, tags: [], chatCapable: false, profile: { id: 'gamma' } },
  ],
  plans: ['studio'],
}
const ROUTE = { modelIds: ['alpha:free'], writable: true }
const ids = (models) => models.map((model) => model.id).join(',')

check(
  'a free model is never 套餐内',
  internals.planCovered(VIEW.models[0]) === false && internals.planCovered(VIEW.models[1]) === true,
)
check(
  'no filter shows the whole catalog and marks the route entry known',
  ids(internals.derivePanel(VIEW, ROUTE, '', {}, []).visible) === 'alpha:free,beta,gamma'
  && internals.derivePanel(VIEW, ROUTE, '', {}, []).known['alpha:free'] === true,
)
check(
  'the 套餐内 filter keeps plan-covered paid models only',
  ids(internals.derivePanel(VIEW, ROUTE, '', { plan: true }, []).visible) === 'beta',
)
check(
  'the 免费 filter reads the payload flag, not the id suffix',
  ids(internals.derivePanel(VIEW, ROUTE, '', { free: true }, []).visible) === 'alpha:free',
)
check(
  'capability filters are ANDed',
  ids(internals.derivePanel(VIEW, ROUTE, '', { image: true, pdf: true }, []).visible) === 'beta',
)
// The exclusive pair is not a taste call: both at once can only ever match
// nothing, because a free model is never plan-covered. If that ever changes,
// this assertion is what says the mutual exclusion should be revisited.
check(
  'a free model is never plan-covered, so both filters at once matches nothing',
  internals.derivePanel(VIEW, ROUTE, '', { plan: true, free: true }, []).visible.length === 0,
)
check(
  '套餐内 and 免费 release each other instead of stacking',
  JSON.stringify(internals.toggleFilter({}, 'free')) === '{"free":true}'
  && JSON.stringify(internals.toggleFilter({ free: true }, 'plan')) === '{"plan":true}'
  && JSON.stringify(internals.toggleFilter({ plan: true }, 'free')) === '{"free":true}'
  && JSON.stringify(internals.toggleFilter({ plan: true }, 'plan')) === '{}',
  JSON.stringify(internals.toggleFilter({ free: true }, 'plan')),
)
check(
  'a capability filter leaves the exclusive pair alone',
  JSON.stringify(internals.toggleFilter({ plan: true }, 'image')) === '{"plan":true,"image":true}',
  JSON.stringify(internals.toggleFilter({ plan: true }, 'image')),
)
// `embedding` marks a different population (embedding models have no chat
// endpoint), so like plan/free it cannot be ANDed with anything — verified here
// as the structural reason, not just as the toggle's behavior.
check(
  'embedding stands alone in both directions',
  JSON.stringify(internals.toggleFilter({ plan: true, image: true }, 'embedding')) === '{"embedding":true}'
  && JSON.stringify(internals.toggleFilter({ embedding: true }, 'pdf')) === '{"pdf":true}'
  && JSON.stringify(internals.toggleFilter({ embedding: true }, 'embedding')) === '{}',
  JSON.stringify(internals.toggleFilter({ plan: true, image: true }, 'embedding')),
)
check(
  'an embedding model carries no chat-model capability, so ANDing finds nothing',
  internals.derivePanel(
    { tags: ['image', 'embedding'], models: [{ id: 'embed-only', tags: ['embedding'], chatCapable: false, profile: { id: 'embed-only' } }] },
    undefined, '', { embedding: true, image: true }, [],
  ).visible.length === 0,
)
check(
  'search is case-insensitive over id and name',
  ids(internals.derivePanel(VIEW, ROUTE, 'BET', {}, []).visible) === 'beta',
)
check(
  'a model already in the route is never offered for adding',
  ids(internals.derivePanel(VIEW, ROUTE, '', {}, ['alpha:free', 'beta']).addable) === 'beta',
)
check(
  'all-visible-picked drives the select-all label',
  internals.derivePanel(VIEW, ROUTE, '', {}, ['alpha:free', 'beta', 'gamma']).allVisiblePicked === true
  && internals.derivePanel(VIEW, ROUTE, '', {}, ['beta']).allVisiblePicked === false,
)
check(
  'the user layer replaces the shipped model array; otherwise the base layer answers',
  ids(internals.routeModelsOf({ user: { providers: { k: { models: [{ id: 'u' }] } } }, base: { providers: { k: { models: [{ id: 'b' }] } } } }, 'k')) === 'u'
  && ids(internals.routeModelsOf({ user: {}, base: { providers: { k: { models: [{ id: 'b' }] } } } }, 'k')) === 'b'
  && internals.routeModelsOf(undefined, 'k').length === 0,
)
check(
  'pathGet answers undefined instead of inventing a default',
  internals.pathGet({ a: { b: 1 } }, ['a', 'b']) === 1 && internals.pathGet({}, ['a', 'b']) === undefined,
)
check(
  'the takeover matches both 模型目录 buttons on the Kenari card and only those',
  'data-kenari-model-picker' === internals.MARKER_ATTR
  && ['添加模型', 'Add model', '获取可用模型', 'Fetch available models']
    .every((label) => internals.TAKEOVER_LABELS.includes(label))
  && internals.TAKEOVER_LABELS.length === 4,
)
// The exact-match half: a prefix rule would also swallow the Models page's own
// 添加提供方, which has nothing to do with this card's model list.
check(
  'the label match is exact, not a prefix',
  internals.isTakeoverLabel('添加模型') === true
  && internals.isTakeoverLabel('获取可用模型') === true
  && internals.isTakeoverLabel('Add model') === true
  && internals.isTakeoverLabel('添加提供方') === false
  && internals.isTakeoverLabel('添加模型 ') === false
  && internals.isTakeoverLabel('') === false,
)

// Collapse-then-expand IS the editing card's remount: dsh unmounts the card on
// collapse (`open ? <ProviderEditor/> : null`), and the card seeds its model list
// once at mount — it deliberately ignores pushed settings refreshes so a
// half-typed key survives them. A write made from this plugin's modal therefore
// only becomes visible in that list by remounting the card.
//
// The deferral matters as much as the click count: collapse is a state update, so
// re-reading `open` inside the same click expands nothing. The sandbox's
// setTimeout runs synchronously, which is what makes both clicks observable here.
//
// And the remount has to VERIFY itself, because the list it re-seeds from is
// React's, which the write reaches asynchronously: an expand that runs too early
// re-seeds the pre-write list and looks exactly like success. Every case below
// therefore drives the ids the card reports, not just the clicks it received.
{
  const toggleWith = (clicks) => ({ textContent: '编辑', click: () => { clicks.push('toggle') } })
  const idInputsWith = (ids) => ids.map((id) => ({ getAttribute: () => '模型 ID 1', value: id }))
  /** One provider row: a toggle, the ids it currently lists, and its fold. */
  const rowWith = (row) => ({
    querySelectorAll: (selector) => {
      if (selector === 'button') return [toggleWith(row.clicks)]
      if (selector === 'input') return idInputsWith(row.ids())
      return []
    },
    querySelector: (selector) => (typeof row.querySelector === 'function' ? row.querySelector(selector) : row.fold),
  })
  const nativeFor = (row) => ({
    closest: (selector) => {
      row.closestCalls += 1
      return selector === 'li' ? rowWith(row) : null
    },
  })

  const steady = { clicks: [], closestCalls: 0, fold: { open: false }, ids: () => ['glm-5-3-flash', 'agnes-2-0-flash:free'] }
  const refreshed = await internals.refreshProviderEditor(nativeFor(steady), ['agnes-2-0-flash:free'])
  check(
    'the remount is confirmed against the ids the card lists, and the fold is reopened to show them',
    refreshed === true && steady.clicks.length === 2 && steady.fold.open === true,
    `clicks=${steady.clicks.length} open=${steady.fold.open}`,
  )
  // The button that opened the picker sits INSIDE the editor, so collapsing
  // detaches it: resolving the row again after the first click answers null and
  // strands the card collapsed. One lookup, before any click, is the invariant.
  check(
    'the row is resolved once, before the click that detaches that button',
    steady.closestCalls === 1,
    `closest calls=${steady.closestCalls}`,
  )

  // The regression this verification exists for: the first collapse/expand lands
  // before React re-rendered the page, so the card re-seeds the list it had
  // BEFORE the write. Firing once and trusting the click count called that a
  // success; the retry is what turns it into one.
  const lagging = {
    clicks: [],
    closestCalls: 0,
    fold: { open: false },
    ids: () => (lagging.clicks.length <= 2 ? ['glm-5-3-flash'] : ['glm-5-3-flash', 'agnes-2-0-flash:free']),
  }
  const retried = await internals.refreshProviderEditor(nativeFor(lagging), ['agnes-2-0-flash:free'])
  check(
    'a card that re-seeds the pre-write list is retried until it agrees',
    retried === true && lagging.clicks.length === 4,
    `clicks=${lagging.clicks.length}`,
  )

  const hopeless = { clicks: [], closestCalls: 0, fold: { open: false }, ids: () => ['glm-5-3-flash'] }
  const never = await internals.refreshProviderEditor(nativeFor(hopeless), ['agnes-2-0-flash:free'])
  check(
    'a list that never agrees reports the refresh as not done, so the copy can say so',
    never === false && hopeless.fold.open === true && hopeless.clicks.length === 16,
    `clicks=${hopeless.clicks.length} open=${hopeless.fold.open}`,
  )

  // A card that was open when the work began must not be left collapsed, but a
  // user who collapses it while the write is in flight asked for it closed: the
  // re-open is fenced on how the card started, not on the mess the budget left.
  const abandoned = {
    clicks: [],
    closestCalls: 0,
    fold: { open: false },
    ids: () => ['glm-5-3-flash'],
    // mounted when the write begins, gone by the time the attempts run out
    querySelector: () => (abandoned.clicks.length >= 16 ? null : abandoned.fold),
  }
  const reopened = await internals.refreshProviderEditor(nativeFor(abandoned), ['agnes-2-0-flash:free'])
  check(
    'a card the last attempt left closed is re-opened, not abandoned',
    reopened === false && abandoned.clicks.length === 17,
    `clicks=${abandoned.clicks.length}`,
  )
  const leftAlone = { clicks: [], closestCalls: 0, fold: null, ids: () => ['glm-5-3-flash'] }
  const untouched = await internals.refreshProviderEditor(nativeFor(leftAlone), ['agnes-2-0-flash:free'])
  check(
    'a card that was already closed is left closed',
    untouched === false && leftAlone.clicks.length === 16,
    `clicks=${leftAlone.clicks.length}`,
  )

  // dsh renders 自定义设置 closed and keeps the model list inside it, so a card
  // opened by hand buries both the list and this plugin's buttons one click deep.
  // The reveal is per `<details>`: React re-creates that element whenever the
  // card reopens, so a reopened card is revealed again while one the user
  // collapsed by hand stays collapsed.
  {
    const fold = { open: false }
    const card = { querySelector: () => fold }
    internals.revealFoldOf(card)
    const onAppear = fold.open
    fold.open = false
    internals.revealFoldOf(card)
    const afterUserCollapse = fold.open
    const remounted = { open: false }
    internals.revealFoldOf({ querySelector: () => remounted })
    check(
      'the model list is unfolded as the card appears, once per <details> element',
      onAppear === true && afterUserCollapse === false && remounted.open === true,
      `onAppear=${onAppear} afterUserCollapse=${afterUserCollapse} remounted=${remounted.open}`,
    )
    check(
      'a card with no fold, or no card, is a no-op',
      internals.revealFoldOf(null) === undefined
      && internals.revealFoldOf({}) === undefined
      && internals.revealFoldOf({ querySelector: () => null }) === undefined,
    )
  }

  check(
    'a row without that toggle fails open instead of throwing',
    (await internals.refreshProviderEditor({ closest: () => ({ querySelectorAll: () => [] }) }, ['x'])) === false
    && (await internals.refreshProviderEditor({ closest: () => null })) === false
    && (await internals.refreshProviderEditor({})) === false
    && (await internals.refreshProviderEditor(null)) === false
    && (await internals.refreshProviderEditor(undefined)) === false,
  )
  check(
    'the toggle labels cover both locales dsh ships',
    internals.EDIT_LABELS.length === 2
    && internals.EDIT_LABELS.indexOf('编辑') !== -1
    && internals.EDIT_LABELS.indexOf('Edit') !== -1,
  )
  check(
    'the model-id field labels cover both locales dsh ships',
    internals.MODEL_ID_LABELS.length === 2
    && internals.MODEL_ID_LABELS.indexOf('模型 ID') !== -1
    && internals.MODEL_ID_LABELS.indexOf('Model ID') !== -1
    && internals.cardModelIds(rowWith(steady)).join(',') === 'glm-5-3-flash,agnes-2-0-flash:free',
  )
}

// The per-row removal button is an icon: it carries an aria-label and no text at
// all, so it is the one takeover that cannot be matched on the button's words.
// The row it names is counted from the card's own removal buttons, which dsh
// renders one per row in row order — the same order `cardModelIds` reads, so a
// click and the id it deletes can never disagree about which row is which.
{
  const removalButton = (index) => ({ textContent: '', getAttribute: () => `删除模型 ${index}` })
  const nameField = { textContent: '', getAttribute: () => '显示名称 1' }
  const first = removalButton(1)
  const second = removalButton(2)
  const third = removalButton(3)
  const buttons = [nameField, first, nameField, second, third]
  const card = { querySelectorAll: () => buttons }
  check(
    'the removal label is matched in both locales, and only with its row number',
    internals.REMOVE_LABELS.length === 2
    && internals.isRemoveLabel('删除模型 1') === true
    && internals.isRemoveLabel('Delete model 12') === true
    && internals.isRemoveLabel('删除模型') === false
    && internals.isRemoveLabel('模型 ID 1') === false
    && internals.isRemoveLabel('') === false,
  )
  check(
    'a removal click names its row by counting the card removal buttons',
    internals.removalRowOf(first, card) === 0
    && internals.removalRowOf(second, card) === 1
    && internals.removalRowOf(third, card) === 2
    && internals.removalRowOf(nameField, card) === -1
    && internals.removalRowOf(removalButton(1), card) === -1
    && internals.removalRowOf(first, null) === -1,
  )
  check(
    'the written list drops exactly that id and keeps the order',
    internals.withoutModel([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'b').map((m) => m.id).join(',') === 'a,c'
    && internals.withoutModel([{ id: 'a' }], 'zz').length === 1
    && internals.withoutModel([{ id: 'b' }, { id: 'b' }], 'b').length === 0,
  )
}

// Every field on the card writes itself now, so the labels are the whole contract
// between dsh's DOM and this bundle's settings writes: a field matched wrongly
// would store a name under an endpoint's key. The row fields carry dsh's own row
// number, and the card's own fields are exactly the same words with no number.
{
  const target = (label) => internals.fieldTargetOf(label)
  check(
    'card fields are matched exactly, and rows by their row number',
    target('显示名称').where === 'card' && target('显示名称').path === 'displayName'
    && target('API 地址').path === 'baseURL'
    && target('API 协议').path === 'api'
    && target('Display name').path === 'displayName'
    && target('Base URL').path === 'baseURL'
    && target('API protocol').path === 'api'
    && target('模型 ID 3').where === 'row' && target('模型 ID 3').index === 2 && target('模型 ID 3').model === 'id'
    && target('显示名称 3').model === 'name'
    && target('上下文窗口 2').model === 'contextWindow' && target('上下文窗口 2').capacity === true
    && target('最大输出 token 2').model === 'maxTokens' && target('最大输出 token 2').capacity === true
    && target('Model ID 1').model === 'id'
    && target('Context window 1').model === 'contextWindow'
    && target('Max output tokens 1').model === 'maxTokens',
  )
  check(
    'a label this bundle does not write is refused, not guessed',
    target('API 密钥') === null
    && target('模型 ID') === null
    && target('模型 ID 0') === null
    && target('模型 ID x') === null
    && target('模型 ID 1x') === null
    && target('模型 ID 1 ') === null
    && target('自定义设置') === null
    && target('') === null
    && target(undefined) === null,
  )
  check(
    'capacities read K and M the way the card spells them',
    internals.capacityOf('8192') === 8192
    && internals.capacityOf('256K') === 256000
    && internals.capacityOf('1M') === 1000000
    && internals.capacityOf(' 1.5M ') === 1500000
    && internals.capacityOf('') === internals.UNSET
    && internals.capacityOf('abc') === undefined
    && internals.capacityOf('-1') === undefined
    && internals.capacityOf('0') === undefined,
  )
  const patched = internals.patchModels(
    [{ id: 'a', name: 'A', compat: { x: 1 } }, { id: 'b', name: 'B' }],
    ['a', 'b'],
    new Map([[1, { name: 'Bee' }]]),
  )
  check(
    'a row edit lands on the row its id names, and leaves the rest of the entry alone',
    patched[1].name === 'Bee' && patched[1].id === 'b'
    && JSON.stringify(patched[0]) === JSON.stringify({ id: 'a', name: 'A', compat: { x: 1 } })
    && internals.patchModels([{ id: 'a' }], ['a'], new Map([[0, { name: 'A' }]]))[0].name === 'A',
  )
  const renamed = internals.patchModels([{ id: 'a', name: 'A' }, { id: 'b' }], ['z', 'b'], new Map([[0, { id: 'z' }]]))
  check(
    'an id edit — the one edit that erases its own link — falls back to the row position',
    renamed[0].id === 'z' && renamed[1].id === 'b',
  )
  const cleared = internals.patchModels([{ id: 'a', name: 'A' }], ['a'], new Map([[0, { name: internals.UNSET }]]))
  check(
    'an emptied field leaves the entry instead of being stored blank',
    cleared.length === 1 && !('name' in cleared[0]),
  )
  const elsewhere = internals.patchModels([{ id: 'a', name: 'A' }, { id: 'b' }], ['b', 'a'], new Map([[0, { name: 'Bee' }]]))
  check(
    'an edit follows the id its row shows, wherever that entry sits',
    elsewhere[1].name === 'Bee' && elsewhere[0].name === 'A',
  )
}

// cardWithMarker walks from a button up to the first ancestor holding the
// marker. The negative case is the one that matters: another provider's card
// must not be claimed, because the native editor is that card's only writer.
//
// The tree mirrors the measured DOM: one <ul> holds one <li> per provider, the
// marker sits in the Kenari card's <li> behind a slot wrapper, and a sibling
// <li> renders buttons whose text is identical. The sibling case is the one
// that caught a real bug — the shared <ul> contains the marker too, so "walk up
// until an ancestor holds the marker" claimed the other provider's button.
{
  const make = (tagName, parentElement) => {
    const node = {
      tagName,
      parentElement,
      ownerDocument: { body: null },
      closest(wanted) {
        const target = String(wanted).toLowerCase()
        let at = node
        while (at !== null) {
          if (String(at.tagName).toLowerCase() === target) return at
          at = at.parentElement
        }
        return null
      },
      contains(other) {
        let at = other
        while (at !== null) {
          if (at === node) return true
          at = at.parentElement
        }
        return false
      },
      querySelector(selector) {
        return selector === `[${internals.MARKER_ATTR}]` && node.contains(marker) ? marker : null
      },
    }
    return node
  }
  const body = { tagName: 'BODY', parentElement: null, ownerDocument: null }
  const rows = make('UL', body)
  const kenariCard = make('LI', rows)
  const marker = make('SPAN', make('DIV', kenariCard))
  // Both buttons sit at the same depth in that card: dsh renders the add button
  // after the row list and the fetch link in the header above it.
  const kenariEditor = make('DIV', kenariCard)
  const kenariButtons = [
    { label: '添加模型', node: make('BUTTON', kenariEditor) },
    { label: '获取可用模型', node: make('BUTTON', kenariEditor) },
  ]
  const otherButton = make('BUTTON', make('DIV', make('LI', rows)))

  const originalQuery = sandbox.document.querySelector
  sandbox.document.querySelector = (selector) =>
    (selector === `[${internals.MARKER_ATTR}]` ? marker : originalQuery(selector))
  try {
    check(
      'the marker anchors the card at its own list item, not the list above it',
      internals.markedCard() === kenariCard && internals.markedCard() !== rows,
    )
    check(
      'the takeover claims a button inside the marked card only',
      kenariButtons.every((button) =>
        internals.isTakeoverLabel(button.label) && internals.cardWithMarker(button.node) === kenariCard)
      && internals.cardWithMarker(otherButton) === null,
    )
  } finally {
    sandbox.document.querySelector = originalQuery
  }
}

// ---------------------------------------------------------------------------
// Render every registered slot once against fake services. Catches what the
// browser would otherwise show as an empty panel: a ReferenceError, a bad prop
// access, or a component that returns nothing.
// ---------------------------------------------------------------------------
try {
  const registered = []
  const registeredLocales = []
  let activeLocale = 'zh'
  const snapshot = {
    status: 'ready',
    value: {
      apiKeyEnv: 'KENARI_API_KEY', baseURL: 'https://kenari.id/v1', timeoutMs: 30000,
      generationTimeoutMs: 180000, maxRetries: 2, catalogCacheTtlMs: 3600000,
      docsCacheTtlMs: 3600000, balanceCacheTtlMs: 300000, lowBalanceAlertRp: 5000,
      searchEnabled: true, fetchEnabled: true, fallbackEnabled: true, toolsEnabled: true,
      budgetCapRp: 0, nativeAdapterEnabled: false, nativeProviderId: 'kenari-direct',
    },
    base: {}, user: { baseURL: 'https://kenari.id/v1' }, revision: 1, writable: true, mode: 'host',
  }
  // The pi-ai namespace as `settings.describe()` reports it: the composition
  // layer owns the preset models, which is what the picker appends to.
  const piAiView = {
    ns: 'llm-pi-ai', schema: {}, revision: 7, applies: true, secrets: [],
    value: { providers: { kenari: { models: [{ id: 'step-3-7-flash:free' }] } } },
    base: { providers: { kenari: { models: [{ id: 'step-3-7-flash:free' }] } } },
  }
  const ctx = {
    effect: (callback) => callback(),
    // The bundle binds its translator from here and registers its dictionaries
    // here. `bind` returns a lookup into whichever dictionary the gate selects,
    // so the components under test render real copy rather than raw keys.
    locale: {
      bind: (ns) => {
        if (ns !== exports.__internals.LOCALE_NS) throw new Error(`bound the wrong locale namespace: ${ns}`)
        return (key, params) => {
          const dict = exports.__internals.LOCALES[activeLocale]
          let text = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
          for (const [name, value] of Object.entries(params ?? {})) {
            text = text.replace(`{${name}}`, String(value))
          }
          return text
        }
      },
      register: (ns, dicts) => {
        registeredLocales.push({ ns, dicts })
        return () => {}
      },
    },
    settingsScope: {
      bind: () => ({ getSnapshot: () => snapshot, subscribe: () => () => {}, set: async () => {}, mutate: async () => {}, unset: async () => {} }),
    },
    remote: {
      llm: { discoverModels: async () => ({ ok: true, value: [{ id: 'step-3-7-flash:free', name: 'x', contextWindow: 262144 }] }) },
      credentials: { describe: async () => ({ ok: true, value: { KENARI_API_KEY: { configured: true, source: 'user-env', writable: false } } }) },
      settings: { describe: async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces: [piAiView] } }) },
    },
    slots: {
      inject: (_slot, register) => register(),
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  const section = registered.find((entry) => entry.options.name === 'settings.section')
  check('apply registers the settings section', section !== undefined, `${registered.length} registration(s)`)
  const tree = section.component({ close: () => {}, ...section.options.inject() })
  check('section renders a non-empty element tree', tree !== undefined && tree !== null && typeof tree === 'object')

  const card = registered.find((entry) => entry.options.name === 'settings.models.provider-card')
  check('apply registers the models provider-card seat', card !== undefined && card.options.key === 'llm-pi-ai',
    card === undefined ? 'missing' : `key=${card.options.key}`)
  const cardFace = card.options.inject()
  // Both faces: the Kenari row renders the takeover anchor, another pi-ai route
  // renders nothing — not even the marker, or the takeover would claim that
  // route's button.
  const kenariRow = card.component({ provider: { provider: 'kenari', settingsNs: 'llm-pi-ai' }, configured: true, keyConfigured: true, ...cardFace })
  check('the kenari card renders the takeover anchor', contains(kenariRow, (el) => el.props?.[internals.MARKER_ATTR] === 'kenari'))
  const otherRow = card.component({ provider: { provider: 'acme-gateway', settingsNs: 'llm-pi-ai' }, configured: true, keyConfigured: false, ...cardFace })
  check('another pi-ai route renders no anchor', otherRow === null)

  // The dialog body itself, rendered directly because the anchor only mounts it
  // on a click the gate cannot dispatch. This is the one pass that would catch a
  // bad tag/pill prop in the picker's own tree.
  const modal = internals.ModelCatalogModal({ onClose: () => {}, nativeButton: undefined, ...cardFace })
  const footer = modal?.props?.footer
  check(
    'the picker dialog renders its chrome, body, and footer',
    modal?.props?.title === internals.LOCALES.zh['catalog.title']
    && modal?.props?.closeLabel === internals.LOCALES.zh['catalog.close']
    && modal?.props?.children?.props?.children === internals.LOCALES.zh['catalog.loading']
    && Array.isArray(footer?.props?.children) && footer.props.children.length === 3,
  )
  // dsh's card is sized for bare ids; this dialog's rows carry an id plus tags,
  // so it must carry the class that the injected rule widens.
  check(
    'the picker dialog asks for the wider card',
    modal?.props?.className === 'kenari-catalog-dialog'
    && appendedNodes.length === 2
    && appendedNodes.some((node) => /\.kenari-catalog-dialog\[role="dialog"\]\{width:min\(820px,92vw\)/.test(node.textContent)),
    appendedNodes.map((node) => node.textContent).join(' | '),
  )

  // ---- the settings nav icon ----------------------------------------------
  // `apply` installed the rule, probed the route, and started observing; the
  // browser only ever runs the rest after the image loads and settings opens,
  // so the gate drives those two steps by hand.
  const navRule = internals.navIconRule()
  const probe = createdNodes.find((node) => node.tag === 'img')
  check(
    'apply injects the nav-icon rule and probes the favicon route',
    appendedNodes.some((node) => node.textContent === navRule) && probe?.src === internals.NAV_ICON_URL,
    `${appendedNodes.length} style node(s); probe=${probe?.src}`,
  )
  check(
    'the nav-icon rule hides dsh\'s own glyph and draws this plugin\'s icon at its size',
    navRule.includes(`[${internals.NAV_ICON_ATTR}] svg{display:none}`)
    && navRule.includes(`url("${internals.NAV_ICON_URL}")`)
    && navRule.includes('content:""')
    && navRule.includes('width:16px')
    && navRule.includes('flex:none'),
    navRule,
  )
  check(
    'the nav icon watches the body for the settings panel',
    observers.length === 1 && observers[0].target === sandbox.document.body,
    `${observers.length} observer(s)`,
  )
  check(
    'the nav row lookup is scoped to the settings rail',
    internals.NAV_ROW_SELECTOR === '[role="dialog"] nav button',
    internals.NAV_ROW_SELECTOR,
  )
  // The style element carries its own marker: sharing the row attribute would
  // make `[data-kenari-nav-icon]` ambiguous between a row and a stylesheet.
  check(
    'the injected style and the claimed row do not share a marker attribute',
    internals.NAV_ICON_STYLE_ATTR !== internals.NAV_ICON_ATTR
    && internals.NAV_ICON_STYLE_ATTR !== '' && internals.NAV_ICON_ATTR !== '',
    `${internals.NAV_ICON_ATTR} / ${internals.NAV_ICON_STYLE_ATTR}`,
  )
  check(
    'the injected style carries the style marker, not the row marker',
    createdNodes.some((node) => node.tag === 'style' && node.attributes?.[internals.NAV_ICON_STYLE_ATTR] === ''),
    `${createdNodes.filter((node) => node.tag === 'style').length} style node(s)`,
  )

  const fakeRow = (label) => {
    const attributes = {}
    return {
      textContent: label,
      attributes,
      setAttribute(name, value) {
        attributes[name] = value
      },
    }
  }
  const generalRow = fakeRow('General')
  const navKenariRow = fakeRow('Kenari')
  const nearMissRow = fakeRow('Kenari-direct')
  check(
    'the exact label picks the Kenari row, not a longer label starting with it',
    internals.settingsNavButton(
      { querySelectorAll: () => [generalRow, navKenariRow, nearMissRow] }, 'Kenari',
    ) === navKenariRow,
  )
  check(
    'marking a row sets the one attribute the rule keys on',
    internals.markNavRow({ querySelectorAll: () => [navKenariRow] }, 'Kenari') === navKenariRow
    && navKenariRow.attributes[internals.NAV_ICON_ATTR] === '',
  )
  check(
    'a rail with no matching row marks nothing',
    internals.markNavRow({ querySelectorAll: () => [] }, 'Kenari') === null,
  )

  // The deferred half, in the order the browser runs it: the panel mounts while
  // the probe is still pending (nothing may change — that is the fail-open half,
  // a 404 has to leave dsh's gear rather than an empty slot), and the row is
  // marked only once `onload` has proved the route answers.
  const liveRow = fakeRow('Kenari')
  const originalQueryAll = sandbox.document.querySelectorAll
  sandbox.document.querySelectorAll = (selector) => (selector === internals.NAV_ROW_SELECTOR ? [liveRow] : [])
  try {
    observers[0].callback([
      { addedNodes: [{ nodeType: 1, matches: () => false, querySelector: () => ({}) }] },
    ])
    check(
      'a panel mounting before the probe resolves changes nothing',
      liveRow.attributes[internals.NAV_ICON_ATTR] === undefined,
      JSON.stringify(liveRow.attributes),
    )
    probe.onload()
    check(
      'the row is marked once the image has loaded',
      liveRow.attributes[internals.NAV_ICON_ATTR] === '',
      JSON.stringify(liveRow.attributes),
    )
  } finally {
    sandbox.document.querySelectorAll = originalQueryAll
  }

  // ---- localization --------------------------------------------------------
  check(
    'the bundle registers its own dictionaries, under its own namespace',
    registeredLocales.length === 1
    && registeredLocales[0].ns === internals.LOCALE_NS
    && registeredLocales[0].dicts === internals.LOCALES,
    `${registeredLocales.length} registration(s)`,
  )
  const zhKeys = Object.keys(internals.LOCALES.zh).sort()
  const enKeys = Object.keys(internals.LOCALES.en).sort()
  const missingInEn = zhKeys.filter((key) => !enKeys.includes(key))
  const extraInEn = enKeys.filter((key) => !zhKeys.includes(key))
  check(
    'the English dictionary covers every Chinese key, with none extra',
    missingInEn.length === 0 && extraInEn.length === 0,
    `zh=${String(zhKeys.length)} en=${String(enKeys.length)}; missing=[${missingInEn.join(', ')}] extra=[${extraInEn.join(', ')}]`,
  )
  // A key that resolves to itself renders as the literal `field.timeoutMs` in
  // front of a user — which is exactly how a renamed key fails: silently.
  const specKeys = []
  for (const spec of internals.LOCALE_SPECS) {
    specKeys.push(spec.labelKey)
    if (spec.hintKey !== undefined) specKeys.push(spec.hintKey)
  }
  // The usage block's own heading and column heads are rendered inline rather
  // than through a spec, so they are listed here.
  specKeys.push(
    'usage.title', 'usage.hint', 'usage.what', 'usage.ask',
    'models.title', 'models.summary', 'models.hint', 'models.colId', 'models.colName', 'models.colContext',
  )
  for (const fact of internals.TOOL_ONLY_FACTS) specKeys.push(fact.what, fact.ask)
  const unresolved = specKeys.filter((key) =>
    !Object.prototype.hasOwnProperty.call(internals.LOCALES.zh, key)
    || !Object.prototype.hasOwnProperty.call(internals.LOCALES.en, key))
  check(
    'every field label, hint and tool row resolves in both locales',
    unresolved.length === 0,
    unresolved.length === 0 ? `${String(specKeys.length)} keys` : unresolved.join(', '),
  )
  // This copy is written for someone who cannot call a tool. `kenari_list_models`
  // is an identifier they would have to look up, and one leaked into the model
  // list's hint precisely because it was accurate to the implementation.
  {
    const jargon = []
    for (const locale of ['zh', 'en']) {
      for (const [key, text] of Object.entries(internals.LOCALES[locale])) {
        if (/kenari_[a-z_]+/.test(text)) jargon.push(`${locale}:${key}`)
      }
    }
    check('no user-facing copy names a tool identifier', jargon.length === 0, jargon.join(', '))
  }
  // The nav label is a thunk for a reason: the shell re-reads it per locale.
  check(
    'the nav label follows the active locale instead of being frozen at registration',
    section.options.label() === internals.LOCALES.zh.nav,
    String(section.options.label()),
  )
  check(
    'no registration asks for copy from a namespace other than its own',
    registered.every((entry) => entry.options.locale === undefined || entry.options.locale === internals.LOCALE_NS),
    registered.map((entry) => `${entry.options.name}=${String(entry.options.locale)}`).join(', '),
  )
  {
    // The switch under test: with the English table active the page must render
    // English. This is the assertion that catches a string left inline, because
    // an inlined literal is the one text a locale switch never reaches.
    activeLocale = 'en'
    const englishSection = section.component({ close: () => {}, ...section.options.inject() })
    const texts = []
    walk(englishSection, (element) => {
      if (typeof element.props?.children === 'string') texts.push(element.props.children)
    })
    activeLocale = 'zh'
    check(
      'switching the active locale switches the rendered copy',
      texts.includes(internals.LOCALES.en['connection.title'])
      && !texts.includes(internals.LOCALES.zh['connection.title']),
      texts.slice(0, 4).join(' | '),
    )
  }

  // ---- the folded groups and the collapsed model list ---------------------
  const collapsed = internals.Disclosure({ title: 't', children: 'BODY' })
  const opened = internals.Disclosure({ title: 't', defaultOpen: true, children: 'BODY' })
  const bodyOf = (element) => (Array.isArray(element.props.children) ? element.props.children : [element.props.children])
  check(
    'a fold is closed unless it is asked to open',
    bodyOf(collapsed).includes('BODY') === false && bodyOf(opened).includes('BODY') === true,
    JSON.stringify(bodyOf(collapsed)),
  )
  check(
    'the fold head is a real button that reports its state',
    collapsed?.props?.children?.[0]?.type === 'button'
    && collapsed.props.children[0].props['aria-expanded'] === false
    && opened.props.children[0].props['aria-expanded'] === true,
  )
  check(
    'the collapsed model list shows three rows, and the open one shows them all',
    internals.MODEL_PREVIEW_COUNT === 3
    && internals.visibleModels(['a', 'b', 'c', 'd'], false).join(',') === 'a,b,c'
    && internals.visibleModels(['a', 'b', 'c', 'd'], true).join(',') === 'a,b,c,d',
  )
  check(
    'a context window reads as a magnitude rather than as a token count',
    internals.formatContextWindow(1048576) === '1M'
    && internals.formatContextWindow(1050000) === '1.1M'
    && internals.formatContextWindow(872000) === '872K'
    && internals.formatContextWindow(32000) === '32K'
    && internals.formatContextWindow(undefined) === undefined
    && internals.formatContextWindow(0) === undefined,
    `${String(internals.formatContextWindow(1048576))} / ${String(internals.formatContextWindow(872000))}`,
  )
  // dsh's discovery fills `name` with the id when the endpoint publishes no name,
  // so the row printed the id twice. Every case below is a real shape it returns.
  {
    const listed = [
      { id: 'agnes-2-0-flash:free', name: 'agnes-2-0-flash:free' },
      { id: 'glm-5-3-flash', name: 'GLM 5.3 Flash' },
      { id: 'unknown-model', name: 'unknown-model' },
      { id: 'no-name-field' },
    ]
    const named = internals.withDisplayNames(listed, { 'agnes-2-0-flash:free': 'Agnes 2.0 Flash', 'glm-5-3-flash': 'GLM 5.3 Flash' })
    check(
      'a listed name that is just the id is replaced by the catalog display name',
      named[0].name === 'Agnes 2.0 Flash'
      && named[1].name === 'GLM 5.3 Flash',
      JSON.stringify(named.map((m) => `${m.id}→${m.name}`)),
    )
    check(
      'without a resolved name the id is not printed twice',
      named[2].name === '' && named[3].name === '',
      JSON.stringify(named.slice(2).map((m) => `${m.id}→${m.name}`)),
    )
    check(
      'a catalog name equal to the id is treated as no name',
      internals.withDisplayNames([{ id: 'x', name: 'x' }], { x: 'x' })[0].name === '',
    )
    check('the join does not mutate the rows it is given', listed[0].name === 'agnes-2-0-flash:free')
  }
  {
    // Three columns, three different words: the id column and the name column
    // were indistinguishable while both printed the same string.
    const heads = ['models.colId', 'models.colName', 'models.colContext'].map((key) => internals.LOCALES.zh[key])
    check(
      'the model table carries three distinct column labels',
      new Set(heads).size === 3 && heads.every((head) => typeof head === 'string' && head.length > 0)
      && internals.LOCALES.en['models.colName'] === 'Display name',
      heads.join(' | '),
    )
  }
  check(
    'a capability id with no translation of its own prints as itself',
    internals.tagLabel('image') === internals.LOCALES.zh['tag.image']
    && internals.tagLabel('quantum') === 'quantum',
  )

  // ---- read-only rows, and where the key reference sits --------------------
  // The read-only rows used to stack the label and the value as two plain lines
  // of the same 13px text, which made "网页搜索" and "已开启" read as two labels.
  // The value now wears a pill; this asserts the two are styled apart, because
  // "they look the same" is exactly the regression a prop check can catch.
  const readOnly = internals.ReadOnlyRow({
    spec: { field: 'searchEnabled', labelKey: 'restart.search' },
    value: true,
  })
  const readOnlyLabel = readOnly.props.children[0]
  const readOnlyValue = readOnly.props.children[1].props.children
  check(
    'a read-only label and its value do not share one style',
    readOnlyLabel.props.style.borderRadius === undefined
    && readOnlyValue.props.style.borderRadius === '999px'
    && readOnlyValue.props.children === internals.LOCALES.zh['field.on'],
    `${String(readOnlyLabel.props.style.borderRadius)} / ${String(readOnlyValue.props.style.borderRadius)}`,
  )
  check(
    'a boolean read-only value says on/off rather than true/false',
    internals.ReadOnlyRow({ spec: { field: 'f', labelKey: 'restart.search' }, value: false })
      .props.children[1].props.children.props.children === internals.LOCALES.zh['field.off'],
  )
  // The key reference is a fact about the key, so it belongs in the 密钥 group
  // rather than behind 高级设置 — and it stays read-only there.
  check(
    'the key reference is a read-only row of the key group, not a folded parameter',
    internals.ADVANCED_FIELDS.every((spec) => spec.field !== 'apiKeyEnv')
    && internals.KEY_REFERENCE_FIELD.field === 'apiKeyEnv'
    && internals.KEY_REFERENCE_FIELD.kind === 'readonly'
    && internals.LOCALE_SPECS.indexOf(internals.KEY_REFERENCE_FIELD) !== -1,
  )
  // Where the row sits is the point of the move, and document order is the only
  // way to see it from a rendered tree: the reference name must land between the
  // key-status row and the next group's heading.
  const orderedTexts = []
  walk(expand(tree), (el) => {
    if (typeof el.props?.children === 'string') orderedTexts.push(el.props.children)
  })
  const at = (text) => orderedTexts.indexOf(text)
  check(
    'the key group renders the reference name it reports on',
    at(internals.LOCALES.zh['field.apiKeyEnv']) > at(internals.LOCALES.zh['connection.keyStatus'])
    && at(internals.LOCALES.zh['field.apiKeyEnv']) < at(internals.LOCALES.zh['models.title']),
    `at=${String(at(internals.LOCALES.zh['field.apiKeyEnv']))} status=${String(at(internals.LOCALES.zh['connection.keyStatus']))} models=${String(at(internals.LOCALES.zh['models.title']))}`,
  )
  // The usage table used to answer "which tool name", which is legible and not
  // actionable. The right column is now the question to ask.
  check(
    'the usage table shows the question to ask instead of a tool name',
    contains(tree, (el) => el.props?.children === internals.LOCALES.zh['usage.balance.ask'])
    && contains(tree, (el) => el.props?.children === internals.LOCALES.zh['usage.ask'])
    && contains(tree, (el) => el.props?.children === 'kenari_balance / kenari_usage') === false
    && contains(tree, (el) => el.props?.children === 'kenari_list_models') === false,
  )
  check(
    'the settings page no longer carries its own read-only catalog entry point',
    section.options.inject().loadPanel === undefined,
  )
} catch (err) {
  check('slots render without throwing', false, String(err && err.stack ? err.stack.split('\n')[0] : err))
}

// The loader reads this export path; a typo means "no bundle" at activation.
const clientExport = pkg.exports?.['./client']
const clientPath = typeof clientExport === 'string' ? clientExport : clientExport?.default
check('package exports["./client"] points at the bundle', clientPath === './client/index.js', String(clientPath))
check('package declares dsh.client for the web platform', pkg.dsh?.client?.platform === 'web')

if (failures.length > 0) {
  console.error(`\nclient bundle check failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('\nclient bundle check passed')
