/** 共享业务逻辑：分块、证据定位、脏数据归一化（与 Python 版逐一对应）。 */
import type { ComplianceItem, ComplianceStatus, RagChunk, RequirementItem, RequirementList } from './types.ts'
import { config } from './config.ts'

const CATEGORIES = ['评分点', '资质门槛', '技术参数', '商务条款', '废标条款'] as const

export function clip(text: string): string {
  return text.length <= config.maxTextChars ? text : text.slice(0, config.maxTextChars) + '\n…[截断]'
}

/** 按段落边界切块，块间保留重叠，避免评分表格被拦腰切断。 */
export function chunkText(text: string): string[] {
  const t = clip(text)
  const size = config.chunkSize
  const overlap = config.chunkOverlap
  const chunks: string[] = []
  let pos = 0
  while (pos < t.length) {
    let end = Math.min(pos + size, t.length)
    if (end < t.length) {
      const cut = t.lastIndexOf('\n\n', end)
      if (cut > pos + size - 800) end = cut
    }
    chunks.push(t.slice(pos, end))
    if (end >= t.length) break
    pos = end > overlap ? end - overlap : end
  }
  return chunks
}

/** 在草稿中定位关键词，返回上下文片段作为证据。 */
export function findEvidence(draft: string, keywords: string[], width = 80): string {
  const low = draft.toLowerCase()
  for (const kw of keywords) {
    const idx = low.indexOf(kw.toLowerCase())
    if (idx >= 0) {
      const start = Math.max(0, idx - width)
      const end = Math.min(draft.length, idx + kw.length + width)
      return draft.slice(start, end).replace(/\s+/g, ' ').trim()
    }
  }
  return ''
}

/** 脏数据 -> RequirementList：未知类别降级、空壳过滤、连续重编号。 */
export function normalizeRequirements(data: unknown): RequirementList {
  const items: RequirementItem[] = []
  const rawItems = (data as { items?: unknown })?.items
  if (Array.isArray(rawItems)) {
    for (const raw of rawItems) {
      if (typeof raw !== 'object' || raw === null) continue
      const r = raw as Record<string, unknown>
      const content = String(r.content ?? '').trim()
      if (content.length < 4) continue
      const catRaw = String(r.category ?? '商务条款')
      const category = (CATEGORIES as readonly string[]).includes(catRaw)
        ? (catRaw as RequirementItem['category'])
        : '商务条款'
      const kws = Array.isArray(r.keywords) ? r.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 5) : []
      items.push({
        id: `R${String(items.length + 1).padStart(3, '0')}`, // 过滤脏数据后连续重编号，不留空洞
        category,
        content,
        mandatory: typeof r.mandatory === 'boolean' ? r.mandatory : category === '废标条款' || category === '资质门槛',
        keywords: kws,
        source_chunk: typeof r.source_chunk === 'string' ? r.source_chunk : undefined,
      })
    }
  }
  return { tender_name: String((data as { tender_name?: unknown })?.tender_name ?? ''), items }
}

/** LLM 语义复核单条要求的结论归一化。 */
export function normalizeSingleCheck(data: Record<string, unknown>): { status: ComplianceStatus; evidence: string; comment: string } {
  const status = String(data.status ?? '缺失')
  const allowed: ComplianceStatus[] = ['完全响应', '偏离', '缺失']
  return {
    status: allowed.includes(status as ComplianceStatus) ? (status as ComplianceStatus) : '缺失',
    evidence: String(data.evidence ?? ''),
    comment: String(data.comment ?? ''),
  }
}

export function summarize(report: { items: ComplianceItem[] }): {
  total: number
  fully_met: number
  deviated: number
  missing: number
} {
  return {
    total: report.items.length,
    fully_met: report.items.filter((x) => x.status === '完全响应').length,
    deviated: report.items.filter((x) => x.status === '偏离').length,
    missing: report.items.filter((x) => x.status === '缺失').length,
  }
}

/** 检索结果 -> 带来源的素材列表。 */
export function formatChunks(question: string, chunks: RagChunk[]): Record<string, unknown> {
  return {
    question,
    results: chunks.map((c) => ({
      source: c.document_keyword || c.docnm_kwd || '未知文档',
      similarity: c.similarity,
      content: (c.content ?? '').slice(0, 2000),
      dataset_id: c.dataset_id,
      document_id: c.document_id,
    })),
  }
}
