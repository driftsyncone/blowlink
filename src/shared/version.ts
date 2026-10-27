// newer: true if version a (x.y.z, optional leading v) is above b. With the same x.y.z, a release is
// newer than its own pre-releases (0.3.0 is above 0.3.0-beta.1), and pre-releases compare by their suffix.
export function newer(a: string, b: string): boolean {
  const split = (v: string) => {
    const [core, ...pre] = v.replace(/^v/, '').split('-')
    return { n: core.split('.').map(Number), pre: pre.join('-') }
  }
  const [x, y] = [split(a), split(b)]
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0)
  if (x.pre === y.pre) return false
  if (!x.pre) return true
  if (!y.pre) return false
  return x.pre.localeCompare(y.pre, undefined, { numeric: true }) > 0
}
