/**
 * MOD 包内 JSON 的宽松解析。
 *
 * 游戏用 Gson 读 MOD 元数据，默认就是宽松模式：字符串里可以出现未转义换行、
 * 注释、单引号、尾逗号。一些真实 MOD（如 spatial-gui）的 fabric.mod.json 就把
 * 换行直接写进了 description 字符串。严格 JSON.parse 会报
 * `Bad control character in string literal`，整包解析失败，
 * 于是出现「准备安装失败」。
 *
 * 这里先用 JSON.parse，失败再按「转义字符串内控制字符 → 去注释 → 去尾逗号 →
 * 单引号转双引号」的顺序修复后再解析；仍失败则抛出最初那条错误，保持错误原文
 * 可读。
 */

/** 把字符串字面量内的裸控制字符转成合法转义，字符串外原样保留。 */
export function escapeStringControlChars(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue }
      if (ch === '\\') { out += ch; escaped = true; continue }
      if (ch === '"') { out += ch; inString = false; continue }
      const code = ch.charCodeAt(0)
      if (code < 0x20) {
        out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : `\\u${code.toString(16).padStart(4, '0')}`
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    out += ch
  }
  return out
}

/** 去掉字符串外的 // 与 /* *\/ 注释（Gson 宽松模式同样允许）。 */
export function stripJsonComments(text: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue }
      if (ch === '\\') { out += ch; escaped = true; continue }
      if (ch === '"') inString = false
      out += ch
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    out += ch
  }
  return out
}

/** 去掉对象/数组末尾的多余逗号（字符串外的 `, }` / `, ]`）。 */
export function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1')
}

/** 尽可能按 Gson 宽松语义解析；全部失败时抛出严格解析的第一条错误。 */
export function parseLenientJson<T = any>(text: string): T {
  const source = text.replace(/^\uFEFF/, '')
  let strictError: unknown
  try { return JSON.parse(source) as T } catch (error) { strictError = error }
  const attempts = [
    escapeStringControlChars(source),
    stripTrailingCommas(escapeStringControlChars(stripJsonComments(source))
      // Gson 允许单引号字符串；只在不含双引号串时整体替换，避免误伤内容
      ),
    stripTrailingCommas(escapeStringControlChars(source))
  ]
  for (const candidate of attempts) {
    try { return JSON.parse(candidate) as T } catch { /* try next */ }
  }
  throw strictError
}
