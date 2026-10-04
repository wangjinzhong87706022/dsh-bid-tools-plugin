/**
 * docxFacts — 从 docx（OOXML zip）提取确定性审计所需的几何/元数据/痕迹/图片事实。
 *
 * 设计红线（方案 §5.1 / §6）：纯解析、零 LLM。只把"能从文件证明的事实"抽出来，
 * 交给 rules.ts 的判定函数。无法从文件证明的属性（如未显式设置的字体）一律不报 REJECT，
 * 由规则引擎按"未显式设置"降级为 WARN（见 rules.ts 的 notSetWarn）。
 *
 * 这是让河北暗标那 11 条字体/字号/行距/页边距/页眉页脚/水印等几何规则真正生效的卡点：
 * 采集到 paragraphs/doc 事实后，rules.ts 的 GEOMETRY_NEED 才会把它们计入 checked 并判定。
 */
import { readFile } from 'fs/promises'
import JSZip from 'jszip'
import type { Facts, ParagraphFact, DocFact } from './rules.ts'

export interface DocxFacts extends Facts {
  text: string
  metadata: { creator?: string; lastModifiedBy?: string; company?: string }
  marks: { revisions: number; comments: number; hidden_text: number; rsid_count: number }
  images: Array<{ name: string; has_exif: boolean; color_space: string }>
  paragraphs: ParagraphFact[]
  doc: DocFact
}

// ---- 轻量 XML 取值（不引入完整 XML 解析器，够用且零依赖） ----
function getAttr(tag: string, attrName: string, xml: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?\\s${attrName}\\s*=\\s*["']([^"']*)["']`, 'i')
  const m = xml.match(re)
  return m ? m[1] : undefined
}

function extractText(xml: string): string {
  const out: string[] = []
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[1])
  return out.join('')
}

async function readEntry(zip: JSZip, path: string): Promise<string | null> {
  const f = zip.file(path)
  return f ? ((await f.async('string')) as string) : null
}

/** 分析图片：色彩空间（灰度/彩色）+ 是否携带 EXIF/元数据。 */
function analyzeImage(bytes: Buffer): { has_exif: boolean; color_space: string } {
  // PNG
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    let color = 'unknown'
    if (bytes.length > 25) {
      const ct = bytes[25] // IHDR 第 10 字节：颜色类型
      if (ct === 0 || ct === 4) color = 'grayscale'
      else if (ct === 2 || ct === 3 || ct === 6) color = 'rgb'
    }
    const sig = bytes.toString('latin1')
    const hasExif = sig.includes('tEXt') || sig.includes('iTXt') || sig.includes('zTXt')
    return { has_exif: hasExif, color_space: color }
  }
  // JPEG
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const comps = jpegComponents(bytes)
    const color = comps === 1 ? 'grayscale' : comps === 3 ? 'rgb' : 'unknown'
    const sig = bytes.toString('latin1')
    const hasExif = sig.includes('Exif') || sig.includes('http://ns.adobe.com/xap')
    return { has_exif: hasExif, color_space: color }
  }
  return { has_exif: false, color_space: 'unknown' }
}

function jpegComponents(bytes: Buffer): number {
  let i = 2
  while (i < bytes.length - 1) {
    if (bytes[i] !== 0xff) {
      i++
      continue
    }
    const marker = bytes[i + 1]
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2
      continue
    }
    // SOF 段（除 DHT/DAC/JPG）的 data[4] 即颜色分量数
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return bytes[i + 9] ?? 0
    }
    if (i + 4 > bytes.length) break
    const len = (bytes[i + 2] << 8) | bytes[i + 3]
    i += 2 + len
  }
  return 0
}

/**
 * 按字符密度估算页数（OOXML 不存真实页数，纯解析无法证明确切值）。
 * 仅作为「明显超标」报警的近似依据；误差来自图片/表格/空白页未计入。
 * 缺页面尺寸或页边距时返回 undefined（交给规则引擎跳过，不误报）。
 * @param paragraphs 段落几何事实
 * @param margins_cm 页边距（cm）
 * @param pageSizeMm 页面尺寸（mm）
 */
function estimatePageCount(
  paragraphs: ParagraphFact[],
  margins_cm: DocFact['margins_cm'],
  pageSizeMm?: { w_mm: number; h_mm: number },
): number | undefined {
  if (!pageSizeMm) return undefined
  const m = margins_cm ?? {}
  if (
    m.top_cm === undefined ||
    m.bottom_cm === undefined ||
    m.left_cm === undefined ||
    m.right_cm === undefined
  ) {
    return undefined
  }
  // 注意单位：page_size_mm 是毫米，margins_cm 是厘米，相减前统一换算为毫米。
  const usableW = pageSizeMm.w_mm - (m.left_cm + m.right_cm) * 10
  const usableH = pageSizeMm.h_mm - (m.top_cm + m.bottom_cm) * 10
  if (usableW <= 0 || usableH <= 0) return undefined

  // 以字符加权，得到正文平均字号 / 平均行高 / 平均段间距
  let totalChars = 0
  let sumFont = 0
  let sumLineH = 0
  let sumSpacing = 0
  for (const p of paragraphs) {
    const len = (p.text ?? '').length
    if (!len) continue
    const font = avg(p.sizes_pt) ?? 14
    const lineH =
      p.line_spacing_pt != null
        ? p.line_spacing_pt
        : font * (p.line_multiple != null && p.line_multiple > 0 ? p.line_multiple : 1.5)
    const spacing = (p.space_before_pt ?? 0) + (p.space_after_pt ?? 0)
    totalChars += len
    sumFont += font * len
    sumLineH += lineH * len
    sumSpacing += spacing * len
  }
  if (totalChars === 0) return 1
  const avgFont = sumFont / totalChars
  const avgLineH = sumLineH / totalChars
  const avgSpacing = sumSpacing / totalChars

  const CHAR_FACTOR = 0.92 // CJK 全角(1em) 与 ASCII(≈0.5em) 混合折中
  const charWidthMm = (avgFont / 72) * 25.4 * CHAR_FACTOR
  const lineHeightMm = (avgLineH / 72) * 25.4
  const spacingMm = (avgSpacing / 72) * 25.4
  if (charWidthMm <= 0 || lineHeightMm <= 0) return undefined

  const charsPerLine = Math.max(1, Math.floor(usableW / charWidthMm))
  const linesPerPage = Math.max(1, Math.floor(usableH / (lineHeightMm + spacingMm)))
  const charsPerPage = charsPerLine * linesPerPage
  return Math.max(1, Math.ceil(totalChars / charsPerPage))
}

function avg(arr?: number[]): number | undefined {
  if (!arr || !arr.length) return undefined
  let s = 0
  let n = 0
  for (const v of arr) {
    if (Number.isFinite(v)) {
      s += v
      n++
    }
  }
  return n ? s / n : undefined
}

/**
 * 解析一份 docx，返回供规则引擎使用的完整 Facts。
 * @param docxPath 文件绝对路径
 */
export async function collectDocxFacts(docxPath: string): Promise<DocxFacts> {
  const buf = await readFile(docxPath)
  const zip = await JSZip.loadAsync(buf as unknown as Uint8Array)

  const docXml = (await readEntry(zip, 'word/document.xml')) ?? ''
  const coreXml = (await readEntry(zip, 'docProps/core.xml')) ?? ''
  const appXml = (await readEntry(zip, 'docProps/app.xml')) ?? ''

  const bodyText = extractText(docXml)

  // ---- 段落几何/样式 ----
  const paraBlocks = docXml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) ?? []
  const paragraphs: ParagraphFact[] = []
  let idx = 0
  for (const pb of paraBlocks) {
    const pPrMatch = pb.match(/<w:pPr\b[\s\S]*?<\/w:pPr>|<w:pPr\b[^>]*\/>/)
    const pPr = pPrMatch ? pPrMatch[0] : ''
    const style = getAttr('w:pStyle', 'w:val', pPr)
    const isHeading = pPr.includes('<w:outlineLvl') || (style ? /标题|Heading/i.test(style) : false)

    const runBlocks = pb.match(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g) ?? []
    const fontsEastAsia: string[] = []
    const sizesPt: number[] = []
    const colors: string[] = []
    for (const rb of runBlocks) {
      const ea = getAttr('w:rFonts', 'w:eastAsia', rb)
      if (ea) fontsEastAsia.push(ea)
      const sz = getAttr('w:sz', 'w:val', rb)
      if (sz !== undefined) {
        const n = Number(sz)
        if (Number.isFinite(n)) sizesPt.push(n / 2) // sz 为半磅
      }
      const col = getAttr('w:color', 'w:val', rb)
      if (col) colors.push(col)
    }

    const spBefore = getAttr('w:spacing', 'w:before', pPr)
    const spAfter = getAttr('w:spacing', 'w:after', pPr)
    const line = getAttr('w:spacing', 'w:line', pPr)
    const lineRule = getAttr('w:spacing', 'w:lineRule', pPr)
    let lineRuleNorm: string | null = null
    let lineSpacingPt: number | null = null
    let lineMultiple: number | null = null
    if (line !== undefined) {
      const lv = Number(line)
      if (Number.isFinite(lv)) {
        if (lineRule === 'exact') {
          lineRuleNorm = 'exact'
          lineSpacingPt = lv / 20 // exact: line 以 1/20 磅计
        } else {
          lineRuleNorm = lineRule ?? 'auto'
          lineMultiple = lv / 240 // auto: line 以 1/240 行计
        }
      }
    }
    const indFirst = getAttr('w:ind', 'w:firstLine', pPr)
    const indFirstChars = getAttr('w:ind', 'w:firstLineChars', pPr)
    const indHang = getAttr('w:ind', 'w:hanging', pPr)
    const indHangChars = getAttr('w:ind', 'w:hangingChars', pPr)
    let firstLineChars: number | null = null
    if (indFirstChars !== undefined) {
      // Word 2007+ 权威字段：1/100 字符单位（如 200 = 2 字符），与字号无关，优先采信
      const d = Number(indFirstChars)
      if (Number.isFinite(d)) firstLineChars = d / 100
    } else if (indHangChars !== undefined) {
      const d = Number(indHangChars)
      if (Number.isFinite(d)) firstLineChars = -d / 100
    } else if (indFirst !== undefined) {
      // fallback：dxa 换算按 240 twips ≈ 12pt 字符宽，四号(14pt)正文会有约 0.33 字符系统偏差
      const d = Number(indFirst)
      if (Number.isFinite(d)) firstLineChars = d / 240
    } else if (indHang !== undefined) {
      const d = Number(indHang)
      if (Number.isFinite(d)) firstLineChars = -d / 240
    }
    const jc = getAttr('w:jc', 'w:val', pPr)
    const alignment: string | null = jc ? (jc === 'both' ? 'justify' : jc) : null

    paragraphs.push({
      index: idx++,
      text: extractText(pb),
      style,
      is_heading: isHeading || undefined,
      fonts_eastAsia: fontsEastAsia.length ? fontsEastAsia : undefined,
      sizes_pt: sizesPt.length ? sizesPt : undefined,
      colors: colors.length ? colors : undefined,
      line_rule: lineRuleNorm,
      line_spacing_pt: lineSpacingPt,
      line_multiple: lineMultiple,
      first_line_indent_chars: firstLineChars,
      alignment,
      space_before_pt: spBefore !== undefined ? Number(spBefore) / 20 : null,
      space_after_pt: spAfter !== undefined ? Number(spAfter) / 20 : null,
    })
  }

  // ---- 文档级几何：页边距 + 页面尺寸（sectPr） ----
  const sectMatches = docXml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)
  const sect = sectMatches && sectMatches.length ? sectMatches[sectMatches.length - 1] : ''
  const margins_cm: DocFact['margins_cm'] = {}
  let page_size_mm: { w_mm: number; h_mm: number } | undefined
  if (sect) {
    const map: Array<['top' | 'right' | 'bottom' | 'left', 'top_cm' | 'right_cm' | 'bottom_cm' | 'left_cm']> = [
      ['top', 'top_cm'],
      ['right', 'right_cm'],
      ['bottom', 'bottom_cm'],
      ['left', 'left_cm'],
    ]
    for (const [k, key] of map) {
      const v = getAttr('w:pgMar', `w:${k}`, sect)
      if (v !== undefined) {
        const dxa = Number(v)
        if (Number.isFinite(dxa)) margins_cm[key] = Math.round((dxa / 567) * 100) / 100 // 1cm≈567dxa
      }
    }
    const pgw = getAttr('w:pgSz', 'w:w', sect)
    const pgh = getAttr('w:pgSz', 'w:h', sect)
    if (pgw !== undefined && pgh !== undefined) {
      const w = Number(pgw)
      const h = Number(pgh)
      if (Number.isFinite(w) && Number.isFinite(h)) {
        // twips(1/1440 inch) -> mm
        page_size_mm = { w_mm: Math.round((w / 1440) * 25.4 * 10) / 10, h_mm: Math.round((h / 1440) * 25.4 * 10) / 10 }
      }
    }
  }

  // ---- 页眉/页脚 + 水印（页眉页脚中的图形/图片视为水印/企业标识） ----
  const fileNames = Object.keys(zip.files)
  const headerFiles = fileNames.filter((p) => /^word\/header\d*\.xml$/i.test(p))
  const footerFiles = fileNames.filter((p) => /^word\/footer\d*\.xml$/i.test(p))
  let watermarkHits = 0
  for (const hf of [...headerFiles, ...footerFiles]) {
    const xml = await readEntry(zip, hf)
    if (!xml) continue
    watermarkHits +=
      (xml.match(/<pic:pic/g)?.length ?? 0) +
      (xml.match(/<w:drawing/g)?.length ?? 0) +
      (xml.match(/<v:shape/g)?.length ?? 0) +
      (xml.match(/<w:pict/g)?.length ?? 0)
  }

  // ---- 元数据（creator / lastModifiedBy / Company） ----
  const creatorMatch = coreXml.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/)
  const lastModifiedMatch = coreXml.match(/<cp:lastModifiedBy>([\s\S]*?)<\/cp:lastModifiedBy>/)
  const companyMatch = appXml.match(/<(?:wp:)?Company>([\s\S]*?)<\/Company>/)
  const metadata = {
    creator: creatorMatch ? creatorMatch[1].trim() : '',
    lastModifiedBy: lastModifiedMatch ? lastModifiedMatch[1].trim() : '',
    company: companyMatch ? companyMatch[1].trim() : '',
  }

  // ---- 痕迹（修订/批注/隐藏文字/rsid） ----
  const revisions = (docXml.match(/<w:ins[\s>]/g)?.length ?? 0) + (docXml.match(/<w:del[\s>]/g)?.length ?? 0)
  const hiddenText = docXml.match(/<w:vanish/g)?.length ?? 0
  const commentsXml = (await readEntry(zip, 'word/comments.xml')) ?? ''
  const comments = commentsXml
    ? commentsXml.match(/<w:comment\b/g)?.length ?? 0
    : docXml.match(/<w:commentReference/g)?.length ?? 0
  const rsidSet = new Set<string>()
  const rsidRe = /w:rsid\w*="([0-9A-Fa-f]{8})"/g
  let rm: RegExpExecArray | null
  while ((rm = rsidRe.exec(docXml)) !== null) rsidSet.add(rm[1])

  // ---- 图片（EXIF + 色彩空间） ----
  const mediaFiles = fileNames.filter((p) => /^word\/media\//i.test(p))
  const images: DocxFacts['images'] = []
  for (const mf of mediaFiles) {
    const f = zip.file(mf)
    if (!f) continue
    const bytes = Buffer.from((await f.async('uint8array')) as Uint8Array)
    const a = analyzeImage(bytes)
    images.push({ name: mf, has_exif: a.has_exif, color_space: a.color_space })
  }

  // ---- 页数：优先取文档属性真实页数；否则按字符密度估算 ----
  // OOXML 不存储真实页数，纯解析无法证明确切页数。估算仅用于「明显超标」时报警，
  // 近似误差较大（未计入图片/表格/空白页），故规则引擎对估算值设置信闸门，避免误废标。
  let pageCount: number | undefined
  let pageCountSource: string | undefined
  let pageCountEstimated = false
  const pagesMatch = appXml.match(/<Pages>(\d+)<\/Pages>/)
  if (pagesMatch) {
    const n = Number(pagesMatch[1])
    if (Number.isFinite(n)) {
      pageCount = n
      pageCountSource = 'app_props'
    }
  }
  if (pageCount === undefined) {
    const est = estimatePageCount(paragraphs, margins_cm, page_size_mm)
    if (est !== undefined) {
      pageCount = est
      pageCountSource = 'estimated'
      pageCountEstimated = true
    }
  }

  const doc: DocFact = {
    paragraph_count: paragraphs.length,
    header_count: headerFiles.length,
    footer_count: footerFiles.length,
    headers_footers: headerFiles.length + footerFiles.length,
    watermark: watermarkHits,
    page_size_mm,
    page_count: pageCount,
    page_count_source: pageCountSource,
    page_count_estimated: pageCountEstimated,
  }
  if (
    margins_cm.top_cm !== undefined ||
    margins_cm.bottom_cm !== undefined ||
    margins_cm.left_cm !== undefined ||
    margins_cm.right_cm !== undefined
  ) {
    doc.margins_cm = margins_cm
  }

  return {
    text: bodyText,
    paragraphs,
    doc,
    metadata,
    marks: { revisions, comments, hidden_text: hiddenText, rsid_count: rsidSet.size },
    images,
  }
}
