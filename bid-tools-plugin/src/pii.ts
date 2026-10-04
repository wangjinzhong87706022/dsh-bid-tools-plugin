/**
 * PII 脱敏与身份泄露扫描（移植自 AIBidForge3.1 orchestrator._sanitize + common_disclosure.json）。
 *
 * 设计红线：
 * - 暗标（技术标）不得出现投标人名称、地址、人员、联系方式、徽标等可识别信息；
 *   明示部分一律以六个星号「＊＊＊＊＊＊」代替（河北双盲评审要求）。
 * - 本模块纯正则、零 LLM、可复现、可审计。
 *
 * scanDisclosure 直接复用 data/rules/common_disclosure.json 的 text.pattern 规则，
 * 作为唯一事实源，避免与 rules 引擎规则漂移。
 */

import disclosurePack from './data/rules/common_disclosure.json'

/** 六位星号占位符（河北暗标口径）。 */
export const PLACEHOLDER = '＊＊＊＊＊＊'

/** 强脱敏：无论是否暗标都应抹掉的硬 PII。 */
interface PiiPattern {
  type: string
  regex: RegExp
}
// 顺序很关键：先匹配「纯数字」的身份证/银行账号，再匹配统一社会信用代码。
// 身份证(18 位)在银行账号(16-19 位)之前：18 位纯数字更可能是身份证，仅末位 X 的才会落回本正则之后正确分类；
// 若信用代码在前，18 位纯数字银行账号会被先吃掉（只替换前 18 位，残留末位数字）。
const PII_PATTERNS: PiiPattern[] = [
  { type: '手机号码', regex: /1[3-9]\d{9}/g },
  { type: '电子邮箱', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { type: '身份证号', regex: /\b\d{17}[\dXx]\b/g },
  { type: '银行账号', regex: /\b\d{16,19}\b/g },
  { type: '统一社会信用代码', regex: /\b[0-9A-HJ-NPQRTUWXY]{2}\d{6}[0-9A-HJ-NPQRTUWXY]{10}\b/g },
]

export interface MaskResult {
  text: string
  matches: Array<{ type: string; value: string }>
  count: number
}

/** 把正文中强 PII 一律替换为占位符，返回脱敏文本与命中清单。 */
export function maskPII(input: string): MaskResult {
  let text = input
  const matches: Array<{ type: string; value: string }> = []
  for (const p of PII_PATTERNS) {
    text = text.replace(p.regex, (m) => {
      matches.push({ type: p.type, value: m })
      return PLACEHOLDER
    })
  }
  return { text, matches, count: matches.length }
}

export interface LeakHit {
  rule_id: string
  name: string
  severity: 'REJECT' | 'WARN'
  category: string
  match: string
  context: string
  suggestion: string
  auto_fixable: boolean
  needs_review: boolean
}

interface DisclosureRule {
  id: string
  name: string
  category: string
  severity: string
  detect: string
  expect?: { patterns?: string[]; occurrences?: number; exclude_patterns?: string[] }
  message: string
  suggestion: string
  auto_fixable?: boolean
  needs_review?: boolean
}

function textPatternRules(): DisclosureRule[] {
  const pack = disclosurePack as { rules?: DisclosureRule[] }
  return (pack.rules ?? []).filter((r) => r.detect === 'text.pattern')
}

/** 八面身份泄露扫描：单位名称 / 地址 / 人员 / 手机 / 邮箱 / 信用代码 / 银行 / 企业文化。 */
export function scanDisclosure(text: string): { leaks: LeakHit[]; summary: Record<string, number> } {
  const leaks: LeakHit[] = []
  for (const rule of textPatternRules()) {
    const patterns = rule.expect?.patterns ?? []
    const maxOcc = rule.expect?.occurrences ?? 0
    const excludes = rule.expect?.exclude_patterns ?? []
    let hitCount = 0
    for (const rawPat of patterns) {
      let re: RegExp
      try {
        re = new RegExp(rawPat, 'g')
      } catch {
        continue
      }
      let m: RegExpExecArray | null
      let guard = 0
      while ((m = re.exec(text)) !== null && guard < 200) {
        guard++
        const matchText = m[0]
        const start = Math.max(0, m.index - 25)
        const ctx = text.slice(start, m.index + matchText.length + 25)
        if (excludes.some((x) => ctx.includes(x))) {
          if (m.index === re.lastIndex) re.lastIndex++
          continue
        }
        hitCount++
        if (hitCount > maxOcc) {
          leaks.push({
            rule_id: rule.id,
            name: rule.name,
            severity: rule.severity as LeakHit['severity'],
            category: rule.category,
            match: matchText,
            context: ctx.replace(/\s+/g, ' ').trim(),
            suggestion: rule.suggestion,
            auto_fixable: Boolean(rule.auto_fixable),
            needs_review: Boolean(rule.needs_review),
          })
        }
        if (m.index === re.lastIndex) re.lastIndex++
      }
    }
  }
  const summary: Record<string, number> = {}
  for (const l of leaks) summary[l.rule_id] = (summary[l.rule_id] ?? 0) + 1
  return { leaks, summary }
}

/** 便捷封装：先扫描再一次性脱敏可自动修复的命中（手机/邮箱/信用代码/单位名等）。 */
export function scanAndMask(text: string): {
  leaks: LeakHit[]
  masked: MaskResult
  autoFixed: number
} {
  const { leaks } = scanDisclosure(text)
  const masked = maskPII(text)
  const autoFixableIds = new Set(leaks.filter((l) => l.auto_fixable).map((l) => l.rule_id))
  // 统计被自动脱敏覆盖到的规则数量（粗粒度：只要命中且可自动修复，视为已处理）
  const autoFixed = [...autoFixableIds].length
  return { leaks, masked, autoFixed }
}
