// Autoblow cloud API client (https://developers.autoblow.com/). Each device is
// reached through the cluster it is connected to; latency.autoblowapi.com finds it.

export type DeviceType = 'vacuglide' | 'autoblow-ultra' | 'vacupump'

// URL path prefix per device type.
export const apiPrefix: Record<DeviceType, string> = {
  vacuglide: 'vacuglide',
  'autoblow-ultra': 'autoblow',
  vacupump: 'vacupump'
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

export interface ApiOptions {
  discoveryUrl?: string // default https://latency.autoblowapi.com (tests point it at a fake)
  fetch?: typeof fetch
  timeoutMs?: number
}

export class AutoblowApi {
  host = '' // https://<cluster>.autoblowapi.com once discovered
  deviceType = ''
  private discoveryUrl: string
  private fetch: typeof fetch
  private timeoutMs: number

  constructor(
    private token: string,
    opts: ApiOptions = {}
  ) {
    this.discoveryUrl = opts.discoveryUrl ?? 'https://latency.autoblowapi.com'
    this.fetch = opts.fetch ?? fetch
    this.timeoutMs = opts.timeoutMs ?? 5000
  }

  async request(method: string, url: string, body?: unknown): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'x-device-token': this.token }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let resp: Response
    try {
      resp = await this.fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error' // a redirect would carry the token to wherever it points
      })
    } catch (e) {
      // Some errors (an invalid header value) quote the token; never pass that on.
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(this.token ? msg.split(this.token).join('***') : msg)
    }
    const raw = await resp.text()
    let out: Record<string, unknown> = {}
    try {
      out = JSON.parse(raw)
    } catch {
      // not JSON; keep the raw text for the error
    }
    if (resp.status >= 300) {
      if (resp.status === 502) this.host = '' // device dropped off; rediscover next time
      if (resp.status === 401 || resp.status === 403) throw new ApiError(resp.status, `HTTP ${resp.status}: Autoblow rejected the token (check it in the device card)`)
      throw new ApiError(resp.status, `HTTP ${resp.status}: ${raw.trim()}`)
    }
    return out
  }

  // discover finds the device's cluster. Throws if the device is offline or the
  // token belongs to another device type.
  async discover(type: DeviceType): Promise<void> {
    const d = await this.request('GET', `${this.discoveryUrl}/${apiPrefix[type]}/connected`)
    if (d.connected !== true) throw new Error('device offline (put it in online mode)')
    const t = typeof d.deviceType === 'string' ? d.deviceType : ''
    if (t && t !== type) throw new Error(`token is for a ${t}, not a ${type}`)
    this.deviceType = t || type
    this.host = clusterUrl(typeof d.cluster === 'string' ? d.cluster : '', this.testOrigin())
  }

  // A non-default discovery URL is a test API (e.g. the Autoblow emulator); its
  // own origin is then accepted as the cluster.
  private testOrigin(): string | undefined {
    if (this.discoveryUrl === 'https://latency.autoblowapi.com') return undefined
    try {
      return new URL(this.discoveryUrl).origin
    } catch {
      return undefined
    }
  }

  // put sends a command to the device's cluster, discovering it first if needed.
  async put(type: DeviceType, path: string, body?: unknown): Promise<Record<string, unknown>> {
    if (!this.host) await this.discover(type)
    return this.request('PUT', `${this.host}/${apiPrefix[type]}/${path}`, body)
  }
}

// clusterUrl turns the cluster name from /connected into a base URL. The token
// only ever goes to autoblowapi.com hosts, local test hosts, or the test API the
// user configured (testOrigin).
export function clusterUrl(c: string, testOrigin?: string): string {
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(c)) return c
  if (testOrigin) {
    try {
      if (new URL(c).origin === testOrigin) return testOrigin
    } catch {
      // not a URL; fall through
    }
  }
  c = c.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (!c.includes('.')) c += '.autoblowapi.com'
  if (!/^[a-z0-9-]+\.autoblowapi\.com$/i.test(c)) throw new Error(`unexpected cluster ${JSON.stringify(c)}`)
  return 'https://' + c
}

export interface Detected {
  type?: DeviceType // undefined: the device is offline and Autoblow didn't say what it is
  online: boolean
}

const knownTypes: Record<string, DeviceType> = {
  vacuglide: 'vacuglide',
  'autoblow-ultra': 'autoblow-ultra',
  autoblow: 'autoblow-ultra',
  vacupump: 'vacupump'
}

// detectDeviceType asks each device type's /connected endpoint about a token.
// Untested for Ultra/VacuPump tokens: their docs show the same response shape.
export async function detectDeviceType(token: string, opts: ApiOptions = {}): Promise<Detected> {
  const api = new AutoblowApi(token, opts)
  const base = opts.discoveryUrl ?? 'https://latency.autoblowapi.com'
  let offline = false
  let lastErr: unknown
  for (const prefix of Object.values(apiPrefix)) {
    try {
      const d = await api.request('GET', `${base}/${prefix}/connected`)
      const type = typeof d.deviceType === 'string' ? knownTypes[d.deviceType] : undefined
      if (type) return { type, online: d.connected === true }
      if (d.connected === false) offline = true
    } catch (e) {
      lastErr = e
    }
  }
  if (offline) return { online: false }
  throw lastErr instanceof Error ? lastErr : new Error('token not recognised by Autoblow')
}
