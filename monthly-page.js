export function parseMonthlyUsage(text) {
  if (typeof text !== 'string') throw new Error('parse-failed')
  const match = /Total usage\s*\r?\n\s*(\d+(?:\.\d+)?)\s*%/i.exec(text)
  if (match === null) throw new Error('parse-failed')
  const value = Number(match[1])
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('parse-failed')
  const tail = text.slice((match.index ?? 0) + match[0].length)
  const reset = /\bResets\s+([^\r\n]+)/i.exec(tail)
  let resetAt = null
  if (reset !== null) {
    const date = new Date(reset[1].trim())
    if (!Number.isNaN(date.getTime())) resetAt = date.toISOString()
  }
  return { usedPercent: Math.round(value * 100) / 100, resetAt }
}
