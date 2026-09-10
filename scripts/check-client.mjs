/**
 * Build-time gate for the hand-written client bundle.
 *
 * `client/index.js` is not produced by a bundler, so nothing else would catch a
 * syntax error, a wrong registration id, a missing export, or a `require()` of a
 * module the loader's baseline table cannot answer — all of which fail in the
 * browser instead of the build. This executes the file the same way the loader
 * does: it captures the `window.__ModuleLoader__.load` registration, runs the
 * factory with a stub React, and asserts the resulting module face.
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
const BASELINE = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'])
const declaredExternals = new Set(pkg.dsh?.client?.external ?? [])
const requested = []

let registration
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(record) {
        registration = record
      },
    },
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
    if (BASELINE.has(specifier) || declaredExternals.has(specifier)) return {}
    throw new Error(`undeclared module request "${specifier}"`)
  })
} catch (err) {
  check('factory runs against a stub React', false, String(err))
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

check('factory runs against a stub React', true)
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

// Render the registered section once against fake services. Catches what the
// browser would otherwise show as an empty panel: a ReferenceError, a bad prop
// access, or a component that returns nothing.
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
  const ctx = {
    settingsScope: {
      bind: () => ({ getSnapshot: () => snapshot, subscribe: () => () => {}, set: async () => {}, mutate: async () => {}, unset: async () => {} }),
    },
    remote: {
      llm: { discoverModels: async () => ({ ok: true, value: [{ id: 'step-3-7-flash:free', name: 'x', contextWindow: 262144 }] }) },
      credentials: { describe: async () => ({ ok: true, value: { KENARI_API_KEY: { configured: true, source: 'user-env', writable: false } } }) },
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
  check('apply registers exactly one settings section', registered.length === 1 && registered[0].options.name === 'settings.section', `${registered.length} registration(s)`)
  const tree = registered[0].component({ close: () => {}, ...registered[0].options.inject() })
  check('section renders a non-empty element tree', tree !== undefined && tree !== null && typeof tree === 'object')
} catch (err) {
  check('section renders without throwing', false, String(err && err.stack ? err.stack.split('\n')[0] : err))
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
