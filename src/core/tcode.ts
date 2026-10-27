// TCode, as Intiface sends it to a websocket device registered as `tcode-v03`:
// "L0799I250\n" = linear axis 0 to 0.799 over 250 ms. Digits after the axis are a
// fraction (799 → 0.799, 5 → 0.5). Several commands may share a line.

export interface TCodeMove {
  axis: string // e.g. "L0"
  pos: number // 0-1
  intervalMs?: number // I<ms>: move duration
  speed?: number // S<n>: speed instead of a duration (not sent by Intiface today)
}

const cmd = /^([LRVA]\d)(\d+)(?:([IS])(\d+))?$/i

export function parseTCode(text: string): TCodeMove[] {
  const out: TCodeMove[] = []
  for (const word of text.split(/\s+/)) {
    const m = cmd.exec(word)
    if (!m) continue // D (device) commands, stops and anything unknown
    const move: TCodeMove = { axis: m[1].toUpperCase(), pos: Number(m[2]) / 10 ** m[2].length }
    if (m[3]?.toUpperCase() === 'I') move.intervalMs = Number(m[4])
    else if (m[3]) move.speed = Number(m[4])
    out.push(move)
  }
  return out
}

// DSTOP: the device-stop command.
export const hasTCodeStop = (text: string): boolean => /(^|\s)DSTOP(\s|$)/i.test(text)
