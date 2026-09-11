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
 * 获取可用模型 takeover. Both are silent when wrong — a filter that drops the
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
// What the bundle appends to `document.head` (the picker's width rule).
const appendedNodes = []
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(record) {
        registration = record
      },
    },
  },
  // The takeover installs one capture-phase listener on the document, and the
  // width rule is appended to head, so `apply` needs both in scope; nothing here
  // dispatches a real click or paints anything.
  document: {
    body: null,
    querySelector: () => null,
    createElement: () => ({ textContent: '', setAttribute() {} }),
    head: {
      appendChild(node) {
        appendedNodes.push(node)
      },
    },
    addEventListener() {},
    removeEventListener() {},
  },
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
  'the takeover matches the Kenari card and only the Kenari card',
  'data-kenari-model-picker' === internals.MARKER_ATTR
  && internals.FETCH_LABELS.includes('获取可用模型')
  && internals.FETCH_LABELS.includes('Fetch available models'),
)

// cardWithMarker walks from a button up to the first ancestor holding the
// marker. The negative case is the one that matters: another provider's card
// must not be claimed, because the native dialog is that card's only picker.
{
  const body = { querySelector: () => null, parentElement: null, ownerDocument: null }
  const doc = { body }
  const kenariCard = {
    querySelector: (selector) => (selector === `[${internals.MARKER_ATTR}]` ? {} : null),
    parentElement: body,
    ownerDocument: doc,
  }
  const kenariEditor = { querySelector: () => null, parentElement: kenariCard, ownerDocument: doc }
  const kenariButton = { parentElement: kenariEditor, ownerDocument: doc }
  const otherEditor = { querySelector: () => null, parentElement: body, ownerDocument: doc }
  const otherButton = { parentElement: otherEditor, ownerDocument: doc }
  check(
    'the takeover claims a button inside the marked card only',
    internals.cardWithMarker(kenariButton) === kenariCard && internals.cardWithMarker(otherButton) === null,
  )
}

// ---------------------------------------------------------------------------
// Render every registered slot once against fake services. Catches what the
// browser would otherwise show as an empty panel: a ReferenceError, a bad prop
// access, or a component that returns nothing.
// ---------------------------------------------------------------------------
try {
  const registered = []
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
  const modal = internals.ModelCatalogModal({ allowAdd: true, onClose: () => {}, nativeButton: undefined, ...cardFace })
  const footer = modal?.props?.footer
  check(
    'the picker dialog renders its chrome, body, and footer',
    modal?.props?.title === '选择要添加的模型'
    && modal?.props?.closeLabel === '关闭'
    && modal?.props?.children?.props?.children === '正在读取模型目录…'
    && Array.isArray(footer?.props?.children) && footer.props.children.length === 3,
  )
  // dsh's card is sized for bare ids; this dialog's rows carry an id plus tags,
  // so it must carry the class that the injected rule widens.
  check(
    'the picker dialog asks for the wider card',
    modal?.props?.className === 'kenari-catalog-dialog'
    && appendedNodes.length === 1
    && /\.kenari-catalog-dialog\[role="dialog"\]\{width:min\(820px,92vw\)/.test(appendedNodes[0].textContent),
    appendedNodes.map((node) => node.textContent).join(' | '),
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
