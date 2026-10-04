/**
 * docx 审计回归测试：用 jszip 现场构造"违规 docx"与"合规 docx"，
 * 验证 docxFacts 的 OOXML 几何事实采集 + rules.ts 的 11 条暗标几何规则真正生效。
 * 由 `npm run test:smoke` 在编译到 .smoke-out 后调用。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const JSZip = require('jszip')
const { collectDocxFacts } = require('../.smoke-out/docxFacts.js')
const { validateFacts } = require('../.smoke-out/rules.js')

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) {
    pass++
    console.log('  PASS', name)
  } else {
    fail++
    console.log('  FAIL', name, extra !== undefined ? '=> ' + JSON.stringify(extra) : '')
  }
}

async function buildDocx({ body, headerXml, creator, lastModifiedBy, company }) {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
  )
  zip.file(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:creator>${creator}</dc:creator><cp:lastModifiedBy>${lastModifiedBy}</cp:lastModifiedBy></cp:coreProperties>`,
  )
  zip.file(
    'docProps/app.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Company>${company}</Company></Properties>`,
  )
  if (headerXml) zip.file('word/header1.xml', headerXml)
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${body}</w:document>`,
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

async function main() {
  console.log('\n--- docx 审计：违规样本 ---')
  const badBody = `<w:body>
<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:rFonts w:eastAsia="Arial" w:ascii="Arial"/><w:sz w:val="24"/><w:color w:val="00FF00"/></w:rPr><w:t>投标技术方案联系方式13812345678</w:t></w:r></w:p>
<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:eastAsia="Arial"/><w:sz w:val="24"/></w:rPr><w:t>第二章施工方案</w:t></w:r><w:r><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="28"/></w:rPr><w:t>混凝土浇筑。</w:t></w:r></w:p>
<w:p><w:r><w:rPr></w:rPr><w:t>修订段落</w:t></w:r><w:ins w:id="1" w:author="张三" w:date="2024-01-01T00:00:00Z"><w:r><w:t>插入修订</w:t></w:r></w:ins></w:p>
<w:sectPr><w:pgMar w:top="1701" w:right="1701" w:bottom="1701" w:left="1701" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body>`
  const badHeader = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:p><w:r><w:drawing><pic:pic/></w:drawing></w:r></w:p></w:hdr>`
  const badBuf = await buildDocx({
    body: badBody,
    headerXml: badHeader,
    creator: '某建设公司',
    lastModifiedBy: '李四',
    company: '某建设公司',
  })
  const badPath = path.join(os.tmpdir(), 'bidtools-smoke-bad.docx')
  fs.writeFileSync(badPath, badBuf)

  const badFacts = await collectDocxFacts(badPath)
  ok(badFacts.doc.header_count === 1, 'bad: header_count=1', badFacts.doc.header_count)
  ok(badFacts.doc.watermark >= 1, 'bad: watermark>=1', badFacts.doc.watermark)
  ok(
    badFacts.doc.margins_cm && Math.abs(badFacts.doc.margins_cm.top_cm - 3.0) < 0.05,
    'bad: 上边距≈3cm',
    badFacts.doc.margins_cm,
  )
  ok(badFacts.metadata.company === '某建设公司', 'bad: company 提取', badFacts.metadata.company)
  ok(badFacts.marks.revisions >= 1, 'bad: 修订痕迹=1', badFacts.marks.revisions)
  ok(badFacts.paragraphs.length === 3, 'bad: 3 个段落', badFacts.paragraphs.length)
  ok(
    badFacts.paragraphs[0].fonts_eastAsia && badFacts.paragraphs[0].fonts_eastAsia[0] === 'Arial',
    'bad: 段1字体=Arial',
    badFacts.paragraphs[0].fonts_eastAsia,
  )
  ok(
    badFacts.paragraphs[0].colors && badFacts.paragraphs[0].colors[0] === '00FF00',
    'bad: 段1颜色=00FF00',
    badFacts.paragraphs[0].colors,
  )

  const badVerdict = validateFacts(badFacts, { region: '河北省', industry: '工程' })
  ok(badVerdict.verdict === 'REJECT', 'bad: verdict=REJECT', badVerdict.verdict)
  const badIds = new Set(badVerdict.findings.map((f) => f.rule_id))
  for (const id of [
    'FONT.FAMILY.BODY',
    'FONT.SIZE.BODY',
    'FONT.COLOR',
    'PAGE.MARGIN',
    'DOC.NO_HEADER_FOOTER',
    'DOC.NO_WATERMARK',
    'META.CREATOR',
    'META.COMPANY',
    'META.REVISIONS',
    'LEAK.MOBILE',
  ]) {
    ok(badIds.has(id), 'bad: 命中 ' + id, [...badIds].join(','))
  }
  ok(badVerdict.skipped_rule_count === 0, 'bad: 无跳过规则（几何已生效）', badVerdict.skipped_rule_count)

  console.log('\n--- docx 审计：合规样本 ---')
  const cleanBody = `<w:body>
<w:p><w:pPr><w:jc w:val="both"/><w:ind w:firstLine="480"/><w:spacing w:before="0" w:after="0" w:line="600" w:lineRule="exact"/></w:pPr><w:r><w:rPr><w:rFonts w:eastAsia="宋体" w:ascii="宋体"/><w:sz w:val="28"/><w:color w:val="000000"/></w:rPr><w:t>技术方案：本项目采用钢筋混凝土结构进行施工。</w:t></w:r></w:p>
<w:sectPr><w:pgMar w:top="1418" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body>`
  const cleanBuf = await buildDocx({ body: cleanBody, creator: '', lastModifiedBy: '', company: '' })
  const cleanPath = path.join(os.tmpdir(), 'bidtools-smoke-clean.docx')
  fs.writeFileSync(cleanPath, cleanBuf)

  const cleanFacts = await collectDocxFacts(cleanPath)
  ok(cleanFacts.doc.headers_footers === 0, 'clean: 无页眉页脚', cleanFacts.doc.headers_footers)
  ok(
    cleanFacts.paragraphs[0].fonts_eastAsia && cleanFacts.paragraphs[0].fonts_eastAsia[0] === '宋体',
    'clean: 段1=宋体',
    cleanFacts.paragraphs[0].fonts_eastAsia,
  )
  ok(
    cleanFacts.paragraphs[0].sizes_pt && Math.abs(cleanFacts.paragraphs[0].sizes_pt[0] - 14) < 0.01,
    'clean: 段1=14pt',
    cleanFacts.paragraphs[0].sizes_pt,
  )
  ok(
    cleanFacts.paragraphs[0].first_line_indent_chars !== null &&
      Math.abs(cleanFacts.paragraphs[0].first_line_indent_chars - 2) < 0.05,
    'clean: 首行缩进≈2字符',
    cleanFacts.paragraphs[0].first_line_indent_chars,
  )
  ok(cleanFacts.paragraphs[0].alignment === 'justify', 'clean: 两端对齐', cleanFacts.paragraphs[0].alignment)
  ok(
    cleanFacts.paragraphs[0].line_rule === 'exact' &&
      Math.abs(cleanFacts.paragraphs[0].line_spacing_pt - 30) < 0.5,
    'clean: 固定值30磅',
    [cleanFacts.paragraphs[0].line_rule, cleanFacts.paragraphs[0].line_spacing_pt],
  )

  const cleanVerdict = validateFacts(cleanFacts, { region: '河北省', industry: '工程' })
  ok(cleanVerdict.verdict === 'PASS', 'clean: verdict=PASS', cleanVerdict.verdict)
  ok(cleanVerdict.summary.reject === 0, 'clean: 0 REJECT', cleanVerdict.summary.reject)
  ok(cleanVerdict.skipped_rule_count === 0, 'clean: 无跳过规则', cleanVerdict.skipped_rule_count)

  // 清理临时文件
  try {
    fs.unlinkSync(badPath)
    fs.unlinkSync(cleanPath)
  } catch (_) {}

  console.log(`\n=== docx smoke: ${pass} passed, ${fail} failed ===`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
