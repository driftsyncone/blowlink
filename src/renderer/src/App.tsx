import { useEffect, useRef, useState } from 'react'
import type { DeviceType } from '../../core/autoblow.ts'
import type { BridgeState } from '../../core/bridge.ts'
import type { ConfigView, DeviceView, Snapshot } from '../../shared/api.ts'
import { api, on } from './bridge.ts'

const typeLabel: Record<DeviceType, string> = {
  vacuglide: 'VacuGlide',
  'autoblow-ultra': 'AI Ultra',
  vacupump: 'VacuPump'
}
// Built from Autoblow's docs, never tried on a real device.
const untested: DeviceType[] = ['autoblow-ultra', 'vacupump']

export function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [state, setState] = useState<BridgeState | null>(null)
  const [config, setConfig] = useState<ConfigView | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [update, setUpdate] = useState<Snapshot['update']>(null)

  useEffect(() => {
    api.snapshot().then((s) => {
      setSnap(s)
      setState(s.state)
      setConfig(s.config)
      setLogs(s.logs)
      setUpdate(s.update)
    })
    const offs = [
      on('state', (s) => setState(s as BridgeState)),
      on('config', (c) => setConfig(c as ConfigView)),
      on('log', (l) => setLogs((prev) => [...prev.slice(-499), l as string])),
      on('update', (u) => setUpdate(u as Snapshot['update']))
    ]
    return () => offs.forEach((off) => off())
  }, [])

  if (!snap || !state || !config) return <div className="loading">Starting…</div>

  const running = state.devices.some((d) => d.status.output > 0)
  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="logo" aria-hidden>
            ⚭
          </span>
          <div>
            <h1>BlowLink</h1>
            <p className="sub">Intiface / Buttplug games → Autoblow devices · v{snap.version}</p>
          </div>
        </div>
        <button className={`stop ${running ? 'live' : ''}`} onClick={() => api.stopAll()}>
          Stop all
        </button>
      </header>

      {update && (
        <div className="card update">
          <span>
            BlowLink {update.version} is available.{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), api.openUpdate())}>
              {update.installable ? 'What’s new' : 'Open the release page'}
            </a>
          </span>
          {update.installable && (
            <button disabled={!!update.busy} onClick={() => api.installUpdate()}>
              {update.busy ?? 'Install and restart'}
            </button>
          )}
          {update.error && <span className="error">Update failed: {update.error}</span>}
        </div>
      )}

      {config.apiUrl && (
        <div className="card testapi">
          Test mode: talking to <code>{config.apiUrl}</code> instead of Autoblow. Clear it in Settings to use real devices.
        </div>
      )}

      <ServerCard state={state} config={config} />

      <section>
        <h2>Devices</h2>
        {config.devices.length === 0 && <p className="muted">No devices yet. Add one with its device token.</p>}
        {config.devices.map((d) => (
          <DeviceCard key={d.id} device={d} live={state.devices.find((x) => x.id === d.id)} config={config} />
        ))}
        <AddDevice />
      </section>

      <SettingsCard config={config} autostart={snap.autostart} logFile={snap.logFile} />
      <LogCard logs={logs} />
    </div>
  )
}

function ServerCard({ state, config }: { state: BridgeState; config: ConfigView }) {
  const b = state.buttplug
  return (
    <section className="card">
      <div className="row between">
        <h2>Buttplug mode</h2>
        <Toggle on={config.buttplug.enabled} onChange={(v) => api.updateConfig({ buttplug: { ...config.buttplug, enabled: v } })} />
      </div>
      <p className="muted">Games connect to BlowLink instead of Intiface Central, at the same address.</p>
      {config.buttplug.enabled &&
        (b.listening ? (
          <p>
            <Dot ok /> Listening on <code>ws://127.0.0.1:{b.port}</code> · {b.clients} app{b.clients === 1 ? '' : 's'} connected
          </p>
        ) : (
          <p className="warn">
            <Dot /> {b.error ?? 'Not running.'} If Intiface Central runs on this port, close it, give it another port, or use
            Intiface mode on your devices instead.
          </p>
        ))}
    </section>
  )
}

function DeviceCard({ device: d, live, config }: { device: DeviceView; live?: BridgeState['devices'][number]; config: ConfigView }) {
  const [name, setName] = useState(d.name)
  const [wsName, setWsName] = useState(d.intiface.name)
  const [token, setToken] = useState('')
  useEffect(() => setName(d.name), [d.name])
  useEffect(() => setWsName(d.intiface.name), [d.intiface.name])
  const out = live?.status.output ?? 0
  const update = (patch: Parameters<typeof api.updateDevice>[1]) => api.updateDevice(d.id, patch)

  return (
    <div className="card device">
      <div className="row between">
        <input
          className="title"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== d.name && update({ name: name.trim() })}
          aria-label="Device name"
        />
        <span className="badge">{typeLabel[d.type]}</span>
      </div>

      {untested.includes(d.type) && (
        <p className="warn">
          Untested: built from Autoblow's documentation, never tried on a real {typeLabel[d.type]}. Start with low limits and
          keep Stop all handy.
        </p>
      )}
      <div className="status row">
        <span>
          <Dot ok={live?.status.online} />
          {live?.status.connecting ? 'Connecting…' : live?.status.online ? 'Online' : 'Offline'}
          {live?.status.error && <span className="err"> · {live.status.error}</span>}
        </span>
        {!live?.status.online && !live?.status.connecting && (
          <button className="small" onClick={() => api.connectDevice(d.id)}>
            Connect
          </button>
        )}
      </div>
      {!live?.status.online && !live?.status.connecting && (
        <p className="muted small">Put the device in online mode (hold its mode button 2.5 s), then press Connect.</p>
      )}
      <div className="meter" title={`${out}%`}>
        <div style={{ width: `${out}%` }} />
        <span>{out}%</span>
      </div>

      <div className="modes two">
        <label className="check">
          <input type="checkbox" checked={d.buttplug} onChange={(e) => update({ buttplug: e.target.checked })} />
          List in Buttplug mode
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={d.intiface.enabled}
            onChange={(e) => update({ intiface: { ...d.intiface, enabled: e.target.checked } })}
          />
          Show in Intiface Central
          {d.intiface.enabled && (
            <span className={live?.intiface ? 'ok' : 'muted'}> · {live?.intiface ? 'linked' : `waiting for ${config.intiface.url}`}</span>
          )}
        </label>
      </div>

      {d.intiface.enabled && (
        <div className="steps">
          <p>One-time setup in Intiface Central:</p>
          <ol>
            <li>
              Settings → turn on <b>Device Websocket Server</b>.
            </li>
            <li>
              Devices → add a websocket device: protocol <code>tcode-v03</code>, name{' '}
              <input
                className="narrow"
                value={wsName}
                onChange={(e) => setWsName(e.target.value.replace(/[^\w-]/g, ''))}
                onBlur={() => wsName && wsName !== d.intiface.name && update({ intiface: { ...d.intiface, name: wsName } })}
                aria-label="Intiface websocket device name"
              />
              .
            </li>
            <li>Optional: in the device's settings in Central, set its display name to “{d.name}”.</li>
          </ol>
        </div>
      )}

      {d.type === 'vacupump' ? (
        <div className="grid">
          <label>
            Max vacuum <b>{d.maxVacuumKpa} kPa</b> <span className="muted">(device limit 60)</span>
            <input
              type="range"
              min={5}
              max={60}
              value={d.maxVacuumKpa}
              onChange={(e) => update({ maxVacuumKpa: Number(e.target.value) })}
            />
          </label>
        </div>
      ) : null}
      {d.type === 'vacupump' ? (
        <p className="muted small">
          Levels hold a vacuum up to this limit; stroke rhythm pulses between it and 0 kPa. Every stop releases the vacuum.
        </p>
      ) : (
        <div className="grid">
          <label>
            Max speed <b>{d.maxSpeed}%</b>
            <input type="range" min={5} max={100} value={d.maxSpeed} onChange={(e) => update({ maxSpeed: Number(e.target.value) })} />
          </label>
          {d.type === 'autoblow-ultra' ? (
            <label>
              Motion
              <select value={d.motion} onChange={(e) => update({ motion: e.target.value as DeviceView['motion'] })}>
                <option value="oscillate">Oscillate to the rhythm</option>
                <option value="goto">Follow each move (laggy)</option>
              </select>
            </label>
          ) : (
            <label>
              Strokes become
              <select value={d.mapping} onChange={(e) => update({ mapping: e.target.value as DeviceView['mapping'] })}>
                <option value="velocity">Velocity (like Autoblow's player)</option>
                <option value="tempo">Tempo (strokes/min, depth ignored)</option>
              </select>
            </label>
          )}
        </div>
      )}

      <details>
        <summary>Token and removal</summary>
        <div className="row">
          <input
            type="password"
            placeholder={d.tokenSet ? 'Replace device token' : 'Device token'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button disabled={!token.trim()} onClick={() => update({ token: token.trim() }).then(() => setToken(''))}>
            Save
          </button>
          <button
            className="danger"
            onClick={() => window.confirm(`Remove ${d.name}?`) && api.removeDevice(d.id)}
          >
            Remove
          </button>
        </div>
      </details>
    </div>
  )
}

function AddDevice() {
  const [token, setToken] = useState('')
  const [type, setType] = useState<DeviceType | ''>('')
  const [needType, setNeedType] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const add = async () => {
    setBusy(true)
    setError('')
    const r = await api.addDevice(token, type || undefined)
    setBusy(false)
    if (r.ok) {
      setToken('')
      setType('')
      setNeedType(false)
    } else {
      setError(r.error)
      setNeedType(!!r.needType)
    }
  }

  return (
    <div className="card add">
      <h3>Add a device</h3>
      <p className="muted">
        Paste the device token of your VacuGlide, AI Ultra or VacuPump. BlowLink works out which device it is.{' '}
        <a href="#" onClick={(e) => (e.preventDefault(), api.openDocs('autoblow-token'))}>
          Where to find the token
        </a>
      </p>
      <div className="row">
        <input type="password" placeholder="Device token" value={token} onChange={(e) => setToken(e.target.value)} />
        {needType && (
          <select value={type} onChange={(e) => setType(e.target.value as DeviceType)}>
            <option value="">Device type…</option>
            {Object.entries(typeLabel).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        )}
        <button disabled={busy || !token.trim() || (needType && !type)} onClick={add}>
          {busy ? 'Checking…' : 'Add'}
        </button>
      </div>
      {error && <p className="warn">{error}</p>}
    </div>
  )
}

function SettingsCard({ config, autostart, logFile }: { config: ConfigView; autostart: boolean; logFile: string }) {
  const [auto, setAuto] = useState(autostart)
  const [url, setUrl] = useState(config.intiface.url)
  const [apiUrl, setApiUrl] = useState(config.apiUrl)
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState('')
  const [port, setPort] = useState(String(config.buttplug.port))
  useEffect(() => setPort(String(config.buttplug.port)), [config.buttplug.port])
  useEffect(() => setUrl(config.intiface.url), [config.intiface.url])
  useEffect(() => setApiUrl(config.apiUrl), [config.apiUrl])
  return (
    <section className="card">
      <h2>Settings</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={auto}
          onChange={(e) => {
            setAuto(e.target.checked)
            api.setAutostart(e.target.checked)
          }}
        />
        Start BlowLink in the tray when I log in
      </label>
      <label className="check">
        <input type="checkbox" checked={config.checkUpdates} onChange={(e) => api.setCheckUpdates(e.target.checked)} />
        Tell me when a new version is out (checks GitHub once a day)
      </label>
      <div className="row">
        <button
          disabled={checking}
          onClick={async () => {
            setChecking(true)
            setChecked('')
            const r = await api.checkUpdatesNow()
            setChecking(false)
            setChecked(r.error ? `Couldn't check: ${r.error}` : r.found ? 'A new version is out, see the top of the window.' : 'BlowLink is up to date.')
          }}
        >
          {checking ? 'Checking…' : 'Check for updates now'}
        </button>
        {checked && <span className="muted">{checked}</span>}
      </div>
      <details className="advanced">
        <summary>Advanced</summary>
        <label className="inline">
          Buttplug port
          <input
            className="narrow"
            value={port}
            inputMode="numeric"
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
            onBlur={() => {
              const p = Number(port)
              if (p > 0 && p < 65536 && p !== config.buttplug.port) api.updateConfig({ buttplug: { ...config.buttplug, port: p } })
              else setPort(String(config.buttplug.port))
            }}
          />
          <span className="muted small">Intiface's default is 12345</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={config.verbose} onChange={(e) => api.updateConfig({ verbose: e.target.checked })} />
          Log game messages (for troubleshooting)
        </label>
        <p className="muted small">
          Log file: <code>{logFile}</code>{' '}
          <a href="#" onClick={(e) => (e.preventDefault(), api.openLogFolder())}>
            Show
          </a>
        </p>
        <label>
          Intiface device websocket server
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => /^wss?:\/\/\S+$/.test(url) && url !== config.intiface.url && api.updateConfig({ intiface: { url } })}
          />
        </label>
        <label>
          Autoblow API URL <span className="muted small">(testing only; empty = real devices)</span>
          <input
            value={apiUrl}
            placeholder="https://latency.autoblowapi.com"
            onChange={(e) => setApiUrl(e.target.value)}
            onBlur={() =>
              (apiUrl === '' || /^https?:\/\/\S+$/.test(apiUrl)) && apiUrl !== config.apiUrl && api.updateConfig({ apiUrl })
            }
          />
        </label>
      </details>
    </section>
  )
}

function LogCard({ logs }: { logs: string[] }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])
  return (
    <details className="card log">
      <summary>Log</summary>
      <pre ref={ref}>{logs.join('\n') || 'Nothing yet.'}</pre>
    </details>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)}>
      <span />
    </button>
  )
}

function Dot({ ok }: { ok?: boolean }) {
  return <span className={`dot ${ok ? 'ok' : ''}`} aria-hidden />
}
