// newer: true if version a (x.y.z, optional leading v) is above b. Pre-release
// suffixes are ignored, so 0.2.0-beta.1 counts as 0.2.0.
export function newer(a: string, b: string): boolean {
  const p = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(Number)
  const [x, y] = [p(a), p(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  return false
}
