/**
 * 确定性合规规则引擎（移植自 AIBidForge3.1 rules/{registry,validator}.py）。
 *
 * 设计红线（方案 §5.1 / §6）：
 * - 本引擎不使用任何 LLM。合规判定必须可复现、可解释、可在行政复议中举证。
 * - 每条 finding 都带：定位、期望、实际、政策依据、修复建议。
 * - 仅对「能从 Facts 判定的规则」做判定；需要 OOXML 几何特征（字体/字号/页边距）
 *   的格式类规则，在 Facts 未携带几何特征时静默跳过（由其它步骤的 docx 解析补齐）。
 *
 * Facts 形态（可由 docx 解析步骤或纯文本构造）：
 *   { text?, metadata?{creator,lastModifiedBy,company},
 *     marks?{revisions,comments,hidden_text,rsid_count},
 *     images?[{has_exif,color_space}] }
 */

import commonDisclosure from './data/rules/common_disclosure.json'
import hebeiBaoding from './data/rules/hebei_baoding.json'
import hebeiProvincial from './data/rules/hebei_provincial.json'
import hebeiTransport from './data/rules/hebei_transport.json'
import hebeiZhangjiakou from './data/rules/hebei_zhangjiakou.json'

// ------------------------------------------------------------------ 类型
/** 单个段落的 OOXML 几何/样式事实（由 docxFacts.ts 从 docx 解析得到）。 */
export interface ParagraphFact {
  index: number
  text: string
  style?: string
  is_heading?: boolean
  fonts_eastAsia?: string[]
  sizes_pt?: number[]
  colors?: string[]
  line_rule?: string | null
  line_spacing_pt?: number | null
  line_multiple?: number | null
  first_line_indent_chars?: number | null
  alignment?: string | null
  space_before_pt?: number | null
  space_after_pt?: number | null
}

/** 文档级几何/痕迹事实。 */
export interface DocFact {
  margins_cm?: { top_cm?: number; bottom_cm?: number; left_cm?: number; right_cm?: number }
  page_size_mm?: { w_mm: number; h_mm: number }
  page_count?: number
  page_count_source?: string
  page_count_estimated?: boolean
  paragraph_count?: number
  header_count?: number
  footer_count?: number
  headers_footers?: number
  watermark?: number
}

/**
 * Facts 形态（可由 docx 解析步骤或纯文本构造）：
 *   { text?, metadata?{creator,lastModifiedBy,company},
 *     marks?{revisions,comments,hidden_text,rsid_count},
 *     images?[{name,has_exif,color_space}],
 *     paragraphs?[{...ParagraphFact}], doc?{...DocFact} }
 * 仅当 paragraphs/doc 具备时，几何类规则（字体/字号/页边距等）才会被判定；
 * 否则这些规则计入 skipped_rule_count，不误报（不能证明违规就不判 REJECT）。
 */
export interface Facts {
  text?: string
  metadata?: { creator?: string; lastModifiedBy?: string; company?: string }
  marks?: { revisions?: number; comments?: number; hidden_text?: number; rsid_count?: number }
  images?: Array<{ name?: string; has_exif?: boolean; color_space?: string }>
  paragraphs?: ParagraphFact[]
  doc?: DocFact
}

interface RuleExpect {
  patterns?: string[]
  occurrences?: number
  exclude_patterns?: string[]
  must_be_empty?: boolean
  empty_or_neutral?: boolean
  neutral_values?: string[]
  max?: number
  allowed?: string[]
  // ---- 几何/格式类（detect: run.* / paragraph.* / doc.*）----
  eastAsia?: string[]
  pt?: number
  tolerance?: number
  tolerance_cm?: number
  mult_tolerance?: number
  rule?: string
  multiple?: number
  chars?: number
  value?: string
  before_pt?: number
  after_pt?: number
  top_cm?: number
  bottom_cm?: number
  left_cm?: number
  right_cm?: number
  exclude_styles?: string[]
}
interface Rule {
  id: string
  name: string
  category: string
  type?: string
  severity: string
  detect: string
  expect?: RuleExpect
  message: string
  suggestion?: string
  basis?: string
  auto_fixable?: boolean
  needs_review?: boolean
  _from?: string
}
interface RuleTemplate {
  template_id: string
  name: string
  region: string
  scope: { city?: string[]; industry?: string[]; tender_type?: string[]; note?: string }
  legal_level: string
  effective_from: string
  effective_to: string
  status: string
  supersedes: string[]
  basis: string
  rules: Rule[]
}

const LEVEL_WEIGHT: Record<string, number> = {
  LAW: 100,
  ADMIN_REG: 90,
  MINISTERIAL_RULE: 80,
  LOCAL_REG: 70,
  NORMATIVE: 60,
  STANDARD: 50,
}
const ALWAYS_ON = 'common-disclosure-v1'
const SUPPORTED_DETECT = new Set([
  'text.pattern',
  'metadata.creator',
  'metadata.lastModifiedBy',
  'metadata.company',
  'marks.revisions',
  'marks.comments',
  'marks.hidden_text',
  'marks.rsid_count',
  'images.exif',
  'images.color',
])

// 几何类规则：仅在 Facts 携带对应 OOXML 事实时才判定（否则跳过，不误报）。
// 这批规则正是河北暗标最容易废标、此前被静默跳过的卡点。
const GEOMETRY_NEED: Record<string, 'paragraphs' | 'doc'> = {
  'run.font.name': 'paragraphs',
  'run.font.size': 'paragraphs',
  'run.color': 'paragraphs',
  'paragraph.line_spacing': 'paragraphs',
  'paragraph.first_line_indent': 'paragraphs',
  'paragraph.alignment': 'paragraphs',
  'paragraph.spacing': 'paragraphs',
  'doc.page.margins': 'doc',
  'doc.page_count': 'doc',
  'doc.marks.headers_footers': 'doc',
  'doc.marks.watermark': 'doc',
}

// ------------------------------------------------------------------ 注册表
class RuleRegistry {
  private templates: RuleTemplate[] = []
  constructor(packs: RuleTemplate[]) {
    for (const p of packs) this.templates.push(p)
    this.applySupersede()
  }
  private applySupersede(): void {
    const superseded = new Set<string>()
    for (const t of this.templates) {
      if (t.status === 'ACTIVE') for (const id of t.supersedes) superseded.add(id)
    }
    for (const id of superseded) {
      const t = this.templates.find((x) => x.template_id === id)
      if (t && t.status === 'ACTIVE') t.status = 'ABOLISHED'
    }
  }
  /** 口径匹配：返回（主模板, 叠加模板[], 说明）。 */
  match(opts: {
    region?: string
    city?: string
    industry?: string
    tender_type?: string
    as_of?: string
  }): { primary: RuleTemplate | null; overlays: RuleTemplate[]; explain: Record<string, unknown> } {
    const region = opts.region ?? '河北省'
    const city = opts.city ?? ''
    const industry = opts.industry ?? ''
    const tender_type = opts.tender_type ?? '工程'
    const as_of = opts.as_of ?? new Date().toISOString().slice(0, 10)

    const candidates = this.templates.filter(
      (t) =>
        t.status === 'ACTIVE' &&
        t.template_id !== ALWAYS_ON &&
        (t.region === '*' || t.region === region) &&
        (!t.effective_from || t.effective_from <= as_of) &&
        (!t.effective_to || t.effective_to >= as_of),
    )

    const scored: Array<{ score: number; t: RuleTemplate }> = []
    for (const t of candidates) {
      const cities = t.scope.city ?? ['*']
      const industries = t.scope.industry ?? ['*']
      const types = t.scope.tender_type ?? ['*']
      let score = 0
      if (!cities.includes('*')) {
        if (city && cities.includes(city)) score += 40
        else continue
      }
      if (!industries.includes('*')) {
        if (industry && industries.includes(industry)) score += 30
        else continue
      }
      if (!types.includes('*')) {
        if (types.includes(tender_type)) score += 10
        else continue
      }
      score += (LEVEL_WEIGHT[t.legal_level] ?? 50) / 10
      if (t.effective_from) score += 5
      scored.push({ score, t })
    }
    scored.sort((a, b) => b.score - a.score || (a.t.effective_from < b.t.effective_from ? 1 : -1))
    const primary = scored.length ? scored[0].t : null

    const overlays: RuleTemplate[] = []
    const always = this.templates.find((t) => t.template_id === ALWAYS_ON)
    if (always && always.status === 'ACTIVE') overlays.push(always)

    return {
      primary,
      overlays,
      explain: {
        input: { region, city, industry, tender_type, as_of },
        selected: primary?.template_id ?? null,
        overlay: overlays.map((t) => t.template_id),
      },
    }
  }
  /** 合并生效规则（主模板 + 叠加模板，按 rule_id 去重，主模板优先）。 */
  effectiveRules(opts: {
    region?: string
    city?: string
    industry?: string
    tender_type?: string
    as_of?: string
  }): { rules: Rule[]; explain: Record<string, unknown> } {
    const { primary, overlays, explain } = this.match(opts)
    const merged: Record<string, Rule> = {}
    for (const t of overlays) for (const r of t.rules) merged[r.id] = { ...r, _from: t.template_id }
    if (primary) for (const r of primary.rules) merged[r.id] = { ...r, _from: primary.template_id }
    return { rules: Object.values(merged), explain }
  }
}

const registry = new RuleRegistry([
  commonDisclosure as RuleTemplate,
  hebeiBaoding as RuleTemplate,
  hebeiProvincial as RuleTemplate,
  hebeiTransport as RuleTemplate,
  hebeiZhangjiakou as RuleTemplate,
])

export interface RuleFinding {
  rule_id: string
  name: string
  category: string
  type: string
  severity: string
  message: string
  location: Record<string, unknown>
  expected: string
  actual: string
  suggestion: string
  basis: string
  auto_fixable: boolean
  needs_review: boolean
  source_template: string
}

export interface RuleVerdict {
  verdict: 'REJECT' | 'WARN' | 'PASS'
  score: number
  engine_version: string
  rule_count: number
  checked_rule_count: number
  skipped_rule_count: number
  summary: {
    reject: number
    warn: number
    info: number
    total_findings: number
    rules_triggered: number
    by_category: Record<string, { reject: number; warn: number; info: number }>
  }
  findings: RuleFinding[]
  facts_overview: Record<string, unknown>
  explain: Record<string, unknown>
}

const ENGINE_VERSION = '1.0.0'
const SEVERITY_ORDER: Record<string, number> = { REJECT: 0, WARN: 1, INFO: 2 }

function emptyFinding(rule: Rule): RuleFinding {
  return {
    rule_id: rule.id,
    name: rule.name,
    category: rule.category,
    type: rule.type ?? 'SOFT',
    severity: rule.severity,
    message: rule.message ?? '',
    location: {},
    expected: '',
    actual: '',
    suggestion: rule.suggestion ?? '',
    basis: rule.basis ?? '',
    auto_fixable: Boolean(rule.auto_fixable),
    needs_review: Boolean(rule.needs_review),
    source_template: rule._from ?? '',
  }
}

/** 标题或显式排除样式（标题/Heading/表头）不参与正文类判定。 */
function skipPara(p: ParagraphFact, exclude: string[]): boolean {
  if (p.is_heading) return true
  if (!exclude || !exclude.length) return false
  return exclude.some((k) => (p.style ?? '').includes(k))
}

/** 字体/字号等若文档未显式设置（依赖样式继承），无法证明合规 -> 仅 HARD 规则降级 WARN。 */
function notSetWarn(rule: Rule, fb: RuleFinding[], what: string): void {
  if (rule.type !== 'HARD') return
  const f = emptyFinding(rule)
  f.severity = 'WARN'
  f.message = `${what}未在文档中显式设置，无法证明合规，建议显式设置`
  f.expected = JSON.stringify(rule.expect ?? {})
  f.actual = '未显式设置'
  f.suggestion = `显式设置${what}，不要依赖样式继承，避免评标端渲染差异`
  fb.push(f)
}

function runRule(rule: Rule, facts: Facts, fb: RuleFinding[]): void {
  const expect = rule.expect ?? {}
  switch (rule.detect) {
    case 'text.pattern': {
      const text = facts.text ?? ''
      const patterns = expect.patterns ?? []
      const maxOcc = expect.occurrences ?? 0
      const excludes = expect.exclude_patterns ?? []
      let hits = 0
      const sample: string[] = []
      for (const rawPat of patterns) {
        let re: RegExp
        try {
          re = new RegExp(rawPat, 'g')
        } catch {
          continue
        }
        let m: RegExpExecArray | null
        let guard = 0
        while ((m = re.exec(text)) !== null && guard < 500) {
          guard++
          const matchText = m[0]
          const start = Math.max(0, m.index - 25)
          const ctx = text.slice(start, m.index + matchText.length + 25)
          if (excludes.some((x) => ctx.includes(x))) {
            if (m.index === re.lastIndex) re.lastIndex++
            continue
          }
          hits++
          if (sample.length < 3) sample.push(`「${matchText}」`)
          if (m.index === re.lastIndex) re.lastIndex++
        }
      }
      if (hits > maxOcc) {
        const f = emptyFinding(rule)
        f.location = { occurrences: hits, sample }
        f.expected = `出现次数 ≤ ${maxOcc}`
        f.actual = `${hits} 处：${sample.join('、')}`
        fb.push(f)
      }
      break
    }
    case 'metadata.creator':
    case 'metadata.lastModifiedBy':
    case 'metadata.company': {
      const key = rule.detect.split('.')[1] as 'creator' | 'lastModifiedBy' | 'company'
      const got = (facts.metadata ?? {})[key] ?? ''
      if (expect.must_be_empty) {
        if (got) {
          const f = emptyFinding(rule)
          f.location = { field: key }
          f.expected = '空'
          f.actual = got
          fb.push(f)
        }
      } else if (expect.empty_or_neutral) {
        const neutral = new Set((expect.neutral_values ?? []).map((v) => v.toLowerCase()))
        if (got && !neutral.has(got.toLowerCase())) {
          const f = emptyFinding(rule)
          f.location = { field: key }
          f.expected = '空或中性值'
          f.actual = got
          fb.push(f)
        }
      }
      break
    }
    case 'marks.revisions':
    case 'marks.comments':
    case 'marks.hidden_text':
    case 'marks.rsid_count': {
      const key = rule.detect.split('.')[1] as keyof NonNullable<Facts['marks']>
      const max = expect.max ?? 0
      const got = Number((facts.marks ?? {})[key] ?? 0)
      if (got > max) {
        const f = emptyFinding(rule)
        f.location = { field: key }
        f.expected = `≤ ${max}`
        f.actual = String(got)
        fb.push(f)
      }
      break
    }
    case 'images.exif': {
      const max = expect.max ?? 0
      const bad = (facts.images ?? []).filter((im) => im.has_exif).map((im) => im)
      if (bad.length > max) {
        const f = emptyFinding(rule)
        f.location = { image_count: bad.length }
        f.expected = `≤ ${max} 张带元数据`
        f.actual = `${bad.length} 张`
        fb.push(f)
      }
      break
    }
    case 'images.color': {
      const allowed = new Set(expect.allowed ?? [])
      const bad = (facts.images ?? [])
        .filter((im) => !allowed.has(im.color_space ?? '') && im.color_space !== 'unknown')
        .map((im) => im)
      if (bad.length > 0) {
        const f = emptyFinding(rule)
        f.location = { image_count: bad.length }
        f.expected = allowed.size ? [...allowed].join('/') : '灰度'
        f.actual = `${bad.length} 张非允许色彩`
        fb.push(f)
      }
      break
    }
    // ---------------- 几何/字体类（需 docxFacts 提供 OOXML 事实） ----------------
    case 'run.font.name': {
      const allowed = new Set(expect.eastAsia ?? [])
      const exclude = expect.exclude_styles ?? []
      const bad: Array<{ index: number; font: string; preview: string }> = []
      let seenAny = false
      for (const p of facts.paragraphs ?? []) {
        if (skipPara(p, exclude)) continue
        for (const f of p.fonts_eastAsia ?? []) {
          seenAny = true
          if (f && !allowed.has(f)) bad.push({ index: p.index, font: f, preview: p.text.slice(0, 40) })
        }
      }
      if (bad.length) {
        const f = emptyFinding(rule)
        f.location = { paragraphs: bad.slice(0, 20), count: bad.length }
        f.expected = [...allowed].join('/')
        f.actual = [...new Set(bad.map((b) => b.font))].slice(0, 5).join('/')
        fb.push(f)
      } else if (!seenAny) {
        notSetWarn(rule, fb, '正文字体')
      }
      break
    }
    case 'run.font.size': {
      const target = expect.pt
      const tol = Number(expect.tolerance ?? 0.01)
      const exclude = expect.exclude_styles ?? []
      const bad: Array<{ index: number; size_pt: number; preview: string }> = []
      let seenAny = false
      for (const p of facts.paragraphs ?? []) {
        if (skipPara(p, exclude)) continue
        for (const s of p.sizes_pt ?? []) {
          seenAny = true
          if (target !== undefined && Math.abs(s - target) > tol) bad.push({ index: p.index, size_pt: s, preview: p.text.slice(0, 40) })
        }
      }
      if (bad.length) {
        const f = emptyFinding(rule)
        f.location = { paragraphs: bad.slice(0, 20), count: bad.length }
        f.expected = `${target}pt`
        f.actual = [...new Set(bad.map((b) => String(b.size_pt)))].slice(0, 5).join('/') + 'pt'
        fb.push(f)
      } else if (!seenAny) {
        notSetWarn(rule, fb, '正文字号')
      }
      break
    }
    case 'run.color': {

      const allowed = new Set((expect.allowed ?? []).map((x: string) => String(x).toLowerCase()))
      const bad: Array<{ index: number; color: string; preview: string }> = []
      for (const p of facts.paragraphs ?? []) {
        for (const c of p.colors ?? []) {
          if (c && !allowed.has(String(c).toLowerCase())) bad.push({ index: p.index, color: c, preview: p.text.slice(0, 40) })
        }
      }
      if (bad.length) {
        const f = emptyFinding(rule)
        f.location = { paragraphs: bad.slice(0, 20), count: bad.length }
        f.expected = '黑色(auto)'
        f.actual = [...new Set(bad.map((b) => b.color))].slice(0, 5).join('/')
        fb.push(f)
      }
      break
    }
    case 'paragraph.line_spacing': {
      const wantRule = expect.rule
      const wantPt = expect.pt
      const wantMult = expect.multiple
      const tol = Number(expect.tolerance ?? 0.5)
      // multiple 场景与 pt/exact 场景量纲不同（倍 vs 磅），用独立字段避免单位混淆
      const tolMult = Number(expect.mult_tolerance ?? 0.02)
      const bad: Array<{ index: number; line_rule?: string | null; line_pt?: number | null; multiple?: number | null; preview: string }> = []
      for (const p of facts.paragraphs ?? []) {
        if (!p.text.trim()) continue
        const lr = p.line_rule
        const lp = p.line_spacing_pt
        const lm = p.line_multiple
        let ok = false
        if (wantRule === 'exact' && lr === 'exact' && lp != null && wantPt != null) ok = Math.abs(lp - wantPt) <= tol
        else if (wantMult != null && (lr === null || lr === undefined || lr === 'auto') && lm != null) ok = Math.abs(lm - wantMult) <= tolMult
        if (!ok) bad.push({ index: p.index, line_rule: lr, line_pt: lp, multiple: lm, preview: p.text.slice(0, 40) })
      }
      if (bad.length) {
        const f = emptyFinding(rule)
        const wantDesc = wantRule === 'exact' ? `固定值 ${wantPt} 磅` : `${wantMult} 倍行距`
        f.location = { paragraphs: bad.slice(0, 20), count: bad.length }
        f.expected = wantDesc
        f.actual = bad
          .map((b) => `${b.line_rule}/${b.line_pt}pt/${b.multiple}x`)
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 5)
          .join('; ')
        fb.push(f)
      }
      break
    }
    case 'paragraph.first_line_indent': {
      const want = expect.chars
      const tol = Number(expect.tolerance ?? 0.3)
      const exclude = expect.exclude_styles ?? []
      if (want === undefined) break
      const bad: Array<{ index: number; chars: number; preview: string }> = []
      let seenAny = false
      for (const p of facts.paragraphs ?? []) {
        if (!p.text.trim()) continue
        if (skipPara(p, exclude)) continue
        const v = p.first_line_indent_chars
        if (v === undefined || v === null) continue
        seenAny = true
        if (Math.abs(v - want) > tol) bad.push({ index: p.index, chars: v, preview: p.text.slice(0, 40) })
      }
      if (bad.length) {
        const f = emptyFinding(rule)
        f.location = { paragraphs: bad.slice(0, 20), count: bad.length }
        f.expected = `${want} 字符`
        f.actual = [...new Set(bad.map((b) => String(b.chars)))].slice(0, 5).join('/') + ' 字符'
        fb.push(f)
      } else if (!seenAny) {
        notSetWarn(rule, fb, '首行缩进')
      }
      break
    }
    case 'paragraph.alignment': {
      const want = expect.value
      const exclude = expect.exclude_styles ?? []
      if (!want) break
      const bad: Array<{ index: number; alignment: string; preview: string }> = []
      for (const p of facts.paragraphs ?? []) {
        if (!p.text.trim()) continue
        if (skipPara(p, exclude)) continue
        const v = p.alignment
        if (v === undefined || v === null) continue
        if (v !== want) bad.push({ index: p.index, alignment: v, preview: p.text.slice(0, 40) })
      }
      if (bad.length) {
        const f = emptyFinding(rule)
        f.location = { paragraphs: bad.slice(0, 20), count: bad.length }
        f.expected = String(want)
        f.actual = [...new Set(bad.map((b) => b.alignment))].slice(0, 5).join('/')
        fb.push(f)
      }
      break
    }
    case 'paragraph.spacing': {
      const tol = Number(expect.tolerance ?? 0.5)
      const wantB = expect.before_pt
      const wantA = expect.after_pt
      const bad: Array<{ index: number; before_pt?: number | null; after_pt?: number | null; preview: string }> = []
      for (const p of facts.paragraphs ?? []) {
        if (!p.text.trim()) continue
        const b = p.space_before_pt
        const a = p.space_after_pt
        if (b === undefined && a === undefined) continue
        let ok = true
        if (wantB !== undefined && b != null && Math.abs(b - wantB) > tol) ok = false
        if (wantA !== undefined && a != null && Math.abs(a - wantA) > tol) ok = false
        if (!ok) bad.push({ index: p.index, before_pt: b, after_pt: a, preview: p.text.slice(0, 40) })
      }
      if (bad.length) {
        const f = emptyFinding(rule)
        f.location = { paragraphs: bad.slice(0, 20), count: bad.length }
        f.expected = `段前 ${wantB}pt / 段后 ${wantA}pt`
        f.actual = bad
          .map((b) => `${b.before_pt}/${b.after_pt}`)
          .filter((v, i, a) => a.indexOf(v) === i)
          .slice(0, 5)
          .join('; ')
        fb.push(f)
      }
      break
    }
    case 'doc.page.margins': {

      const tol = Number(expect.tolerance_cm ?? 0.05)
      const m = (facts.doc?.margins_cm ?? {}) as { [key: string]: number | undefined }
      const diffs: Record<string, { expected: number; actual: number | null }> = {}
      const keys: Array<['top_cm' | 'bottom_cm' | 'left_cm' | 'right_cm', 'top_cm' | 'bottom_cm' | 'left_cm' | 'right_cm']> = [
        ['top_cm', 'top_cm'],
        ['bottom_cm', 'bottom_cm'],
        ['left_cm', 'left_cm'],
        ['right_cm', 'right_cm'],
      ]
      for (const [k, key] of keys) {
        const want = expect[k]
        const got = m[key]
        if (want === undefined) continue
        if (got === undefined || Math.abs(got - want) > tol) diffs[k] = { expected: want, actual: got ?? null }
      }
      if (Object.keys(diffs).length) {
        const f = emptyFinding(rule)
        f.location = { margins: diffs }
        f.expected = Object.entries(diffs).map(([k, v]) => `${k}=${v.expected}`).join(' / ')
        f.actual = Object.entries(diffs).map(([k, v]) => `${k}=${v.actual}`).join(' / ')
        fb.push(f)
      }
      break
    }
    case 'doc.page_count': {
      const maxP = expect.max
      const got = facts.doc?.page_count
      const source = facts.doc?.page_count_source
      const estimated = Boolean(facts.doc?.page_count_estimated)
      if (maxP === undefined || got === undefined) break
      if (got > maxP) {
        const f = emptyFinding(rule)
        // 估算误差可能 ±25%（未计入图片/表格/空白页）。红线：不能证明违规就不判 REJECT。
        // 因此估算值仅在「明显远超上限（>上限*1.25）」时才确信超限判 REJECT；
        // 临界区间降级为 WARN，交人工核查，避免误废标。文档属性真实页数则直接采信。
        if (estimated && got <= maxP * 1.25) {
          f.severity = 'WARN'
          f.message = `技术暗标篇幅估算为 ${got} 页（基于字符密度，未计入图片/表格，误差可能 ±25%），接近或超过 ${maxP} 页上限，建议人工核查实际页数`
          f.suggestion = `精简技术方案或人工确认页数，确保不超过 ${maxP} 页`
        }
        f.location = { source, estimated }
        f.expected = `≤ ${maxP} 页`
        f.actual = `${got} 页（${source === 'app_props' ? '文档属性' : '估算'}）`
        fb.push(f)
      }
      break
    }
    case 'doc.marks.headers_footers': {
      const maxV = Number((rule.expect ?? {}).max ?? 0)
      const got = Number(facts.doc?.headers_footers ?? 0)
      if (got > maxV) {
        const f = emptyFinding(rule)
        f.location = { header_count: facts.doc?.header_count, footer_count: facts.doc?.footer_count }
        f.expected = `≤ ${maxV} 个页眉页脚`
        f.actual = `${got} 个（页眉 ${facts.doc?.header_count} / 页脚 ${facts.doc?.footer_count}）`
        fb.push(f)
      }
      break
    }
    case 'doc.marks.watermark': {
      const maxV = Number((rule.expect ?? {}).max ?? 0)
      const got = Number(facts.doc?.watermark ?? 0)
      if (got > maxV) {
        const f = emptyFinding(rule)
        f.location = { watermark_hits: got }
        f.expected = `≤ ${maxV}`
        f.actual = `${got} 处疑似水印/图形对象`
        fb.push(f)
      }
      break
    }
    default:
      // 未知 detect（理论上不会发生）：静默跳过
      break
  }
}

/** 对 Facts 执行全部生效规则，返回判定结果。 */
export function validateFacts(
  facts: Facts,
  ruleInput?: Parameters<RuleRegistry['effectiveRules']>[0],
): RuleVerdict {
  const { rules, explain } = registry.effectiveRules(ruleInput ?? {})
  const findings: RuleFinding[] = []
  let checked = 0
  let skipped = 0
  for (const rule of rules) {
    const need = GEOMETRY_NEED[rule.detect]
    if (need) {
      const present = need === 'paragraphs'
        ? Boolean(facts.paragraphs && facts.paragraphs.length)
        : Boolean(facts.doc)
      if (!present) {
        skipped++
        continue
      }
    } else if (!SUPPORTED_DETECT.has(rule.detect)) {
      skipped++
      continue
    }
    checked++
    try {
      runRule(rule, facts, findings)
    } catch (exc) {
      const f = emptyFinding(rule)
      f.severity = 'WARN'
      f.message = `规则执行异常，已降级为提示：${exc instanceof Error ? exc.message : String(exc)}`
      f.actual = '判定失败'
      findings.push(f)
    }
  }

  findings.sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || (a.rule_id < b.rule_id ? -1 : 1),
  )

  const reject = findings.filter((f) => f.severity === 'REJECT')
  const warn = findings.filter((f) => f.severity === 'WARN')
  const verdict: RuleVerdict['verdict'] = reject.length ? 'REJECT' : warn.length ? 'WARN' : 'PASS'

  let score = 100
  score -= Math.min(reject.length * 15, 60)
  score -= Math.min(warn.length * 3, 30)
  score = Math.round(Math.max(score, 0) * 10) / 10

  const byCategory: Record<string, { reject: number; warn: number; info: number }> = {}
  for (const f of findings) {
    const c = (byCategory[f.category] ??= { reject: 0, warn: 0, info: 0 })
    const k = f.severity.toLowerCase() as 'reject' | 'warn' | 'info'
    if (k in c) c[k]++
  }

  return {
    verdict,
    score,
    engine_version: ENGINE_VERSION,
    rule_count: rules.length,
    checked_rule_count: checked,
    skipped_rule_count: skipped,
    summary: {
      reject: reject.length,
      warn: warn.length,
      info: findings.filter((f) => f.severity === 'INFO').length,
      total_findings: findings.length,
      rules_triggered: new Set(findings.map((f) => f.rule_id)).size,
      by_category: byCategory,
    },
    findings,
    facts_overview: {
      has_text: Boolean(facts.text),
      metadata: facts.metadata ?? {},
      marks: facts.marks ?? {},
      image_count: (facts.images ?? []).length,
      doc: facts.doc ?? {},
    },
    explain,
  }
}

/** 列出当前注册表中的所有规则模板摘要（调试/口径核对用）。 */
export function listTemplates(): Array<{ template_id: string; name: string; region: string; status: string; rule_count: number }> {
  return [
    { template_id: ALWAYS_ON, name: '通用身份泄露与元数据扫描', region: '*', status: 'ACTIVE', rule_count: (commonDisclosure as RuleTemplate).rules.length },
    ...registry['templates'].map((t) => ({
      template_id: t.template_id,
      name: t.name,
      region: t.region,
      status: t.status,
      rule_count: t.rules.length,
    })),
  ]
}
