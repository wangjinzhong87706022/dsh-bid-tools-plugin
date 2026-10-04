/**
 * ProjectFacts 单一事实源：跨章节共享项目事实（工期/限价/资质/企业信息等），
 * 改一处全篇同步。生成后用 checkFactsConsistency 校验章节中的事实与事实表一致。
 *
 * 对应设计文档「项目事实表单一事实源」（文章 9/10）：
 * 解决"法人/信用代码/工期/人员散落多页、手改必漏"的一致性难题。
 */

export interface ProjectFacts {
  project_name: string
  tender_name: string
  facts: Record<string, string>
  updated_at: string
}

/** 从招标要求清单自动提取关键事实（工期/限价/保证金/资质/混凝土等级等）。 */
export function extractFactsFromRequirements(items: Array<{ content: string; category: string }>): Record<string, string> {
  const facts: Record<string, string> = {}
  const allText = items.map((i) => i.content).join('\n')

  const patterns: Array<[string, RegExp]> = [
    ['工期', /工期\s*(?:为\s*)?(\d+)\s*(日历天|天|日)/],
    ['最高投标限价', /(?:最高投标限价|最高限价|招标控制价)\s*(?:约\s*)?([\d,]+(?:\.\d+)?)\s*万元/],
    ['投标保证金', /投标保证金\s*([\d,]+(?:\.\d+)?)\s*万元/],
    ['质量保证金', /质量保证金\s*(\d+(?:\.\d+)?)\s*%/],
    ['缺陷责任期', /缺陷责任期\s*(\d+)\s*个月/],
    ['混凝土等级', /混凝土(?:设计强度等级(?:为|：)?)?\s*(C\d+(?:\.\d+)?)/],
    ['抗渗等级', /抗渗等级\s*(W\d+)/],
    ['资质等级', /(?:总承包|专业承包)\s*([一二三四五]级|特级)/],
    ['项目经理', /(?:一级|二级)\s*建造师(?:[（(]([^)）]+)[)）])?/],
    ['技术标分值', /技术标\s*(\d+)\s*分/],
    ['商务标分值', /商务标\s*(\d+)\s*分/],
    ['价格分分值', /价格分\s*(\d+)\s*分/],
  ]

  for (const [key, re] of patterns) {
    const m = allText.match(re)
    if (m) facts[key] = m[0].replace(/^\s+|\s+$/g, '')
  }

  return facts
}

/** 从文本中提取疑似事实值（用于一致性校验时的数字/参数提取）。 */
function extractNumbers(text: string): Array<{ value: string; context: string }> {
  const results: Array<{ value: string; context: string }> = []
  const numRe = /(\d+(?:\.\d+)?)\s*(日历天|天|日|万元|个月|分|级|C\d+|W\d+|m|cm|mm|℃|%)/g
  let m
  while ((m = numRe.exec(text)) !== null) {
    const start = Math.max(0, m.index - 20)
    const end = Math.min(text.length, m.index + m[0].length + 20)
    results.push({ value: m[0], context: text.slice(start, end) })
  }
  return results
}

export interface ConsistencyFinding {
  fact_key: string
  expected: string
  found_in_text: string
  context: string
  verdict: '一致' | '偏离' | '缺失'
}

export interface ConsistencyReport {
  total: number
  consistent: number
  deviated: number
  missing: number
  findings: ConsistencyFinding[]
}

/**
 * 校验文本中的事实是否与 ProjectFacts 一致。
 * 对每个事实键，在文本中搜索对应值；找不到=缺失，找到但不匹配=偏离。
 */
export function checkFactsConsistency(text: string, facts: Record<string, string>): ConsistencyReport {
  const findings: ConsistencyFinding[] = []

  for (const [key, expected] of Object.entries(facts)) {
    if (!expected) continue
    const expectedNum = expected.match(/(\d+(?:\.\d+)?)/)?.[1]
    if (!expectedNum) continue

    const numbers = extractNumbers(text)
    const matches = numbers.filter((n) => n.value.includes(expectedNum))

    if (matches.length === 0) {
      findings.push({ fact_key: key, expected, found_in_text: '', context: '', verdict: '缺失' })
    } else {
      const allConsistent = matches.every((m) => {
        const factUnit = expected.match(/(日历天|天|日|万元|个月|分|级|℃|%|m|cm|mm)/)?.[1]
        const foundUnit = m.value.match(/(日历天|天|日|万元|个月|分|级|℃|%|m|cm|mm)/)?.[1]
        return factUnit === foundUnit
      })
      if (allConsistent) {
        findings.push({ fact_key: key, expected, found_in_text: matches[0].value, context: matches[0].context, verdict: '一致' })
      } else {
        findings.push({ fact_key: key, expected, found_in_text: matches[0].value, context: matches[0].context, verdict: '偏离' })
      }
    }
  }

  return {
    total: findings.length,
    consistent: findings.filter((f) => f.verdict === '一致').length,
    deviated: findings.filter((f) => f.verdict === '偏离').length,
    missing: findings.filter((f) => f.verdict === '缺失').length,
    findings,
  }
}

/** 创建空事实表。 */
export function createEmptyFacts(projectName = '', tenderName = ''): ProjectFacts {
  return {
    project_name: projectName,
    tender_name: tenderName,
    facts: {},
    updated_at: new Date().toISOString(),
  }
}