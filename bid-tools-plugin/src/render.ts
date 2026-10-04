/**
 * OOXML 渲染：从 Markdown 生成 .docx 标书成品。
 * 直写 OOXML（zip 包含 XML），不依赖 python-docx/docx 包。
 *
 * 支持：标题(H1-H3)/段落/无序列表/有序列表/加粗/斜体/表格/页眉页脚/元数据。
 * 对应设计文档 P4「Word 导出 + 审计留痕」。
 */

import JSZip from 'jszip'
import { writeFile } from 'node:fs/promises'

interface RenderOptions {
  title?: string
  author?: string
  subject?: string
  header?: string
  footer?: string
  fontSize?: number
  fontFamily?: string
}

/** Markdown 行类型 */
interface MdLine {
  type: 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'ul' | 'ol' | 'table' | 'hr' | 'blank'
  text: string
  level?: number
  rows?: string[][]
}

/** 解析 Markdown 为行结构。 */
function parseMarkdown(md: string): MdLine[] {
  const lines = md.split('\n')
  const result: MdLine[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { result.push({ type: 'blank', text: '' }); i++; continue }
    const h = line.match(/^(#{1,4})\s+(.*)/)
    if (h) { result.push({ type: `h${h[1].length}` as MdLine['type'], text: h[2], level: h[1].length }); i++; continue }
    if (/^[-*+]\s+/.test(line)) { result.push({ type: 'ul', text: line.replace(/^[-*+]\s+/, '') }); i++; continue }
    if (/^\d+\.\s+/.test(line)) { result.push({ type: 'ol', text: line.replace(/^\d+\.\s+/, '') }); i++; continue }
    if (/^---+$/.test(line.trim())) { result.push({ type: 'hr', text: '' }); i++; continue }
    if (line.startsWith('|')) {
      const rows: string[][] = []
      while (i < lines.length && lines[i].startsWith('|')) {
        const cells = lines[i].split('|').slice(1, -1).map((c) => c.trim())
        if (!cells.every((c) => /^[-:]+$/.test(c))) rows.push(cells)
        i++
      }
      result.push({ type: 'table', text: '', rows })
      continue
    }
    result.push({ type: 'p', text: line }); i++
  }
  return result
}

/** 转义 XML 特殊字符。 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 渲染内联格式（加粗/斜体）为 OOXML runs。 */
function renderInline(text: string): string {
  let out = ''
  let rest = esc(text)
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*)/
  while (rest.length > 0) {
    const m = rest.match(re)
    if (!m || m.index === undefined) { out += `<w:r><w:t xml:space="preserve">${rest}</w:t></w:r>`; break }
    if (m.index > 0) out += `<w:r><w:t xml:space="preserve">${rest.slice(0, m.index)}</w:t></w:r>`
    if (m[2] !== undefined) {
      out += `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${m[2]}</w:t></w:r>`
    } else if (m[3] !== undefined) {
      out += `<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">${m[3]}</w:t></w:r>`
    }
    rest = rest.slice(m.index + m[0].length)
  }
  return out
}

/** 渲染 Markdown 为 document.xml body 内容。 */
function renderBody(md: string): string {
  const lines = parseMarkdown(md)
  let body = ''
  for (const line of lines) {
    switch (line.type) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4': {
        const lvl = line.level ?? 1
        body += `<w:p><w:pPr><w:pStyle w:val="Heading${lvl}"/></w:pPr>${renderInline(line.text)}</w:p>`
        break
      }
      case 'p':
        body += `<w:p>${renderInline(line.text)}</w:p>`
        break
      case 'ul':
        body += `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${renderInline(line.text)}</w:p>`
        break
      case 'ol':
        body += `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>${renderInline(line.text)}</w:p>`
        break
      case 'hr':
        body += `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>`
        break
      case 'table': {
        if (!line.rows || line.rows.length === 0) break
        body += '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>'
        for (const b of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']) {
          body += `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`
        }
        body += '</w:tblBorders></w:tblPr>'
        for (let r = 0; r < line.rows.length; r++) {
          body += '<w:tr>'
          for (const cell of line.rows[r]) {
            const isHeader = r === 0
            body += `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p><w:pPr>`
            if (isHeader) body += `<w:pStyle w:val="Strong"/>`
            body += `</w:pPr>${renderInline(cell)}</w:p></w:tc>`
          }
          body += '</w:tr>'
        }
        body += '</w:tbl>'
        break
      }
      case 'blank':
        body += '<w:p/>'
        break
    }
  }
  return body
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`

function buildStyles(opts: RenderOptions): string {
  const sz = opts.fontSize ?? 24
  const font = opts.fontFamily ?? '宋体'
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${font}" w:eastAsia="${font}" w:hAnsi="${font}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:pPr><w:keepNext/><w:spacing w:before="120" w:after="60"/><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="${sz + 2}"/><w:szCs w:val="${sz + 2}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>
</w:styles>`
}

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`

const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:defaultTabStop w:val="720"/></w:settings>`

function buildCoreProps(opts: RenderOptions): string {
  const now = new Date().toISOString()
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(opts.title ?? '')}</dc:title>
<dc:creator>${esc(opts.author ?? 'bid-tools-plugin')}</dc:creator>
<dc:subject>${esc(opts.subject ?? '')}</dc:subject>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`
}

const APP_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>bid-tools-plugin</Application></Properties>`

function buildDocument(body: string, opts: RenderOptions): string {
  let headerXml = ''
  let footerXml = ''
  if (opts.header) {
    headerXml = `<w:headerReference w:type="default" r:id="rId4"/>`
  }
  if (opts.footer) {
    footerXml = `<w:footerReference w:type="default" r:id="rId5"/>`
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>${headerXml}${footerXml}</w:sectPr></w:body>
</w:document>`
}

function buildHeaderFooter(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${renderInline(text)}</w:p></w:hdr>`
}

/**
 * 从 Markdown 生成 .docx 文件并写入 outputPath。
 * @returns 文件大小（字节）
 */
export async function renderDocx(markdown: string, outputPath: string, opts: RenderOptions = {}): Promise<number> {
  const body = renderBody(markdown)
  const documentXml = buildDocument(body, opts)

  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES)
  zip.file('_rels/.rels', ROOT_RELS)
  zip.file('word/_rels/document.xml.rels', DOC_RELS)
  zip.file('word/document.xml', documentXml)
  zip.file('word/styles.xml', buildStyles(opts))
  zip.file('word/numbering.xml', NUMBERING)
  zip.file('word/settings.xml', SETTINGS)
  zip.file('docProps/core.xml', buildCoreProps(opts))
  zip.file('docProps/app.xml', APP_PROPS)

  if (opts.header) zip.file('word/header1.xml', buildHeaderFooter(opts.header))
  if (opts.footer) zip.file('word/footer1.xml', buildHeaderFooter(opts.footer))

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  await writeFile(outputPath, buf)
  return buf.length
}