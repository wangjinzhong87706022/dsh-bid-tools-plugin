/**
 * 评标前否决项自检（移植自 AIBidForge5.0 data/eval/scoring_models.json 的
 * precheck_items P01-P12，法律依据：《招标投标法实施条例》第五十一条等）。
 *
 * 设计红线：能确定性判定的项用正则/数值比对直接判定；不能自动判定的项
 * （资格条件、实质性响应、串标、暗标几何）标 MANUAL 并给出对应工具/人工动作，
 * 绝不猜测。P11/P12 按 applies_to 行业过滤适用性。
 */
import scoringModels from './data/eval/scoring_models.json'

interface PrecheckItem {
  code: string
  item: string
  category: string
  severity: string
  basis: string
  check_hint: string
  applies_to?: string[]
}

const PRECHECK_ITEMS = (scoringModels as unknown as { precheck_items: PrecheckItem[] }).precheck_items

export type PrecheckStatus = 'PASS' | 'WARN' | 'REJECT_RISK' | 'MANUAL'

export interface PrecheckItemResult {
  code: string
  item: string
  category: string
  severity: string
  status: PrecheckStatus
  basis: string
  detail: string
  next_action: string
}

export interface PrecheckReport {
  industry: string
  items: PrecheckItemResult[]
  summary: { pass: number; warn: number; reject_risk: number; manual: number }
  disclaimer: string
}

/** 抽取草稿中的投标报价（万元归一为元）。 */
function extractBidPrices(draft: string): number[] {
  const out: number[] = []
  const pat = /(?:投标报价|投标总价|总报价|报价总额)[^\d]{0,15}(\d+(?:\.\d+)?)\s*(亿元|万元|万|元)/g
  let m: RegExpExecArray | null
  let guard = 0
  while ((m = pat.exec(draft)) !== null && guard < 8) {
    let num = parseFloat(m[1])
    if (m[2] === '亿' || m[2] === '亿元') num *= 100_000_000
    else if (m[2] === '万' || m[2] === '万元') num *= 10_000
    out.push(Math.round(num * 100) / 100)
    guard++
    if (m.index === pat.lastIndex) pat.lastIndex++
  }
  return out
}

/** 抽取草稿中的工期承诺（日历天）。 */
function extractDurationDays(draft: string): number | undefined {
  const m = draft.match(/(?:工期|工期承诺|计划工期|总工期)[^\d]{0,15}(\d+)\s*(?:个)?\s*(?:日历天|天|日)/)
  return m ? parseInt(m[1], 10) : undefined
}

function fmtWan(yuan: number): string {
  return `${(yuan / 10_000).toFixed(2)} 万元`
}

/**
 * 对标书草稿做评标前否决项自检（P01-P12，确定性规则，零 LLM）。
 * 资格条件/实质性响应/串标/暗标几何等不可自动判定项标 MANUAL 并指引对应工具。
 */
export function precheckBid(options: {
  draft_text: string
  control_price?: number
  required_duration_days?: number
  industry?: string
  tender_type?: string
}): PrecheckReport {
  const draft = String(options.draft_text ?? '')
  if (!draft.trim()) throw new Error('draft_text 为空')
  const items: PrecheckItemResult[] = []
  const hit = (code: string) => PRECHECK_ITEMS.find((x) => x.code === code)

  const push = (code: string, status: PrecheckStatus, detail: string, next: string) => {
    const src = hit(code)
    if (!src) return
    items.push({
      code: src.code,
      item: src.item,
      category: src.category,
      severity: src.severity,
      status,
      basis: src.basis,
      detail,
      next_action: next,
    })
  }

  // P01 签字盖章
  const hasSign = draft.includes('签字') || draft.includes('签署') || draft.includes('签章')
  const hasSeal = draft.includes('盖章') || draft.includes('公章') || draft.includes('印鉴')
  push(
    'P01',
    hasSign && hasSeal ? 'PASS' : 'WARN',
    hasSign && hasSeal
      ? '草稿含签字与盖章相关表述'
      : `草稿${hasSign ? '未见盖章表述' : hasSeal ? '未见签字表述' : '未见签字盖章表述'}`,
    hasSign && hasSeal ? '定稿前仍需人工核对每页签章位置' : '投标文件未经签字盖章将被否决，定稿前必须人工逐页核对',
  )

  // P02 联合体协议
  if (draft.includes('联合体')) {
    const hasAgreement = draft.includes('联合体协议')
    push(
      'P02',
      hasAgreement ? 'PASS' : 'WARN',
      hasAgreement ? '草稿提及联合体协议' : '草稿提及联合体但未见联合体协议书表述',
      hasAgreement ? '核对协议书各方盖章与分工' : '联合体投标未提交共同投标协议将被否决，须补充协议书',
    )
  } else {
    push('P02', 'PASS', '草稿未提及联合体（按独立投标处理）', '如实际为联合体投标，须补充联合体协议书')
  }

  // P03 资格条件（不可自动判定）
  push('P03', 'MANUAL', '资格条件需对照营业执照/资质证书/人员证书逐项核对', '人工核对资格条件，或用 kb_search_materials 检索资质要求')

  // P04 唯一报价
  const bidPrices = extractBidPrices(draft)
  const distinct = [...new Set(bidPrices)]
  if (distinct.length > 1) {
    push(
      'P04',
      'REJECT_RISK',
      `检测到 ${distinct.length} 个不同投标报价（${distinct.map(fmtWan).join(' / ')}），同一投标人提交两个以上报价将被否决`,
      '删除多余报价，只保留唯一报价（招标文件允许备选投标的除外）',
    )
  } else {
    push('P04', 'PASS', bidPrices.length === 1 ? `检测到唯一报价 ${fmtWan(bidPrices[0])}` : '未检测到多报价表述', '确认全文无备选报价表述')
  }

  // P05 报价范围（限价/成本）
  if (options.control_price !== undefined && options.control_price > 0) {
    if (bidPrices.length > 0) {
      const over = bidPrices.filter((p) => p > options.control_price!)
      const low = bidPrices.filter((p) => p < options.control_price! * 0.7)
      push(
        'P05',
        over.length > 0 ? 'REJECT_RISK' : low.length > 0 ? 'WARN' : 'PASS',
        over.length > 0
          ? `报价 ${over.map(fmtWan).join(' / ')} 高于最高限价 ${fmtWan(options.control_price)}`
          : low.length > 0
            ? `报价 ${low.map(fmtWan).join(' / ')} 低于限价 70%，触发异常低价审查线`
            : `报价在限价 ${fmtWan(options.control_price)} 之内`,
        over.length > 0 ? '调整报价至限价以内' : low.length > 0 ? '准备成本构成自证材料（87号令第60条）' : '保持报价范围',
      )
    } else {
      push('P05', 'MANUAL', `草稿未检测到明确投标报价金额（限价 ${fmtWan(options.control_price)}）`, '补充报价表并核对是否超限价')
    }
  } else {
    push('P05', 'MANUAL', '未提供最高限价，无法自动核对报价范围', '传入 control_price 参数后可自动核对')
  }

  // P06 实质性要求响应
  push('P06', 'MANUAL', '实质性要求响应需对照招标要求清单逐条核查', '用 bid_check_compliance 对照 tender_extract_requirements 的要求清单')

  // P07 串标/作假/行贿
  push('P07', 'MANUAL', '串标与作假需多文件交叉比对', '用 bid_check_collusion 做 SimHash 雷同与报价规律自检')

  // P08 投标保证金
  push(
    'P08',
    draft.includes('保证金') ? 'PASS' : 'WARN',
    draft.includes('保证金') ? '草稿含保证金相关表述' : '草稿未提及投标保证金',
    draft.includes('保证金') ? '核对保证金金额与缴纳方式与招标文件一致' : '确认是否需要缴纳保证金/保函，未按要求提交将否决投标',
  )

  // P09 暗标身份泄露
  push('P09', 'MANUAL', '暗标身份泄露需规则包全文扫描', '用 bid_scan_disclosure 扫描（可 auto_mask=true 直接脱敏）')

  // P10 暗标格式
  push('P10', 'MANUAL', '暗标格式（字体/字号/行距/页边距/页数）需 OOXML 几何事实', '用 bid_audit_docx 审计 docx 文件')

  // P11 ★号参数（材料设备/新能源适用）
  const p11 = hit('P11')
  const industry = options.industry ?? ''
  const p11Applies = p11?.applies_to?.includes(industry) ?? false
  const hasStar = draft.includes('★') || draft.includes('★号')
  if (p11Applies) {
    push(
      'P11',
      hasStar ? 'WARN' : 'PASS',
      hasStar ? `草稿含 ★ 号条款（${industry} 行业适用）` : `未检测到 ★ 号条款（${industry} 行业）`,
      hasStar ? '逐条核对 ★ 号参数零负偏离，附佐证材料' : '对照招标文件确认 ★ 号参数均已响应',
    )
  } else {
    push('P11', 'PASS', `★号参数规则不适用于当前行业（${industry || '未指定'}）`, '')
  }

  // P12 工期与质量承诺
  if (options.required_duration_days !== undefined && options.required_duration_days > 0) {
    const committed = extractDurationDays(draft)
    if (committed === undefined) {
      push('P12', 'MANUAL', `草稿未检测到工期承诺（招标要求 ${options.required_duration_days} 日历天）`, '补充工期承诺并核对不超过招标工期')
    } else if (committed > options.required_duration_days) {
      push(
        'P12',
        'REJECT_RISK',
        `工期承诺 ${committed} 日历天超过招标要求 ${options.required_duration_days} 日历天`,
        '压缩工期至招标要求以内，否则属未响应实质性要求',
      )
    } else {
      push('P12', 'PASS', `工期承诺 ${committed} 日历天 ≤ 招标要求 ${options.required_duration_days} 日历天`, '核对质量目标承诺不低于招标文件要求')
    }
  } else {
    const committed = extractDurationDays(draft)
    push(
      'P12',
      committed === undefined ? 'WARN' : 'PASS',
      committed === undefined ? '草稿未检测到工期承诺' : `检测到工期承诺 ${committed} 日历天（未提供招标要求工期，未做对比）`,
      committed === undefined ? '补充工期承诺' : '传入 required_duration_days 参数可自动核对是否超期',
    )
  }

  const summary = {
    pass: items.filter((x) => x.status === 'PASS').length,
    warn: items.filter((x) => x.status === 'WARN').length,
    reject_risk: items.filter((x) => x.status === 'REJECT_RISK').length,
    manual: items.filter((x) => x.status === 'MANUAL').length,
  }
  return {
    industry,
    items,
    summary,
    disclaimer:
      '本自检覆盖 12 项否决情形中可自动判定的部分（确定性规则，零 LLM）；MANUAL 项需人工或对应工具确认。最终以评标委员会认定为准。',
  }
}