/**
 * 页数估算回归测试：构造不同篇幅的 docx，验证 docxFacts 的字符密度页数估算
 * 与 rules.ts 的 DOC.PAGE_COUNT 置信闸门（估算接近上限→WARN，远超→REJECT，不误废标）。
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

async function buildDocx(body, { creator = '', company = '' } = {}) {
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
<dc:creator>${creator}</dc:creator><cp:lastModifiedBy>${creator}</cp:lastModifiedBy></cp:coreProperties>`,
  )
  zip.file(
    'docProps/app.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Company>${company}</Company></Properties>`,
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${body}</w:document>`,
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

// 单段落正文：宋体 14pt、黑色、固定值30磅、首行缩进2字符、两端对齐、A4、页边距 2.5/2/2/2
function makeBody(textLen) {
  const text = '施'.repeat(textLen)
  return `<w:body>
<w:p><w:pPr><w:jc w:val="both"/><w:ind w:firstLine="480"/><w:spacing w:before="0" w:after="0" w:line="600" w:lineRule="exact"/></w:pPr><w:r><w:rPr><w:rFonts w:eastAsia="宋体" w:ascii="宋体"/><w:sz w:val="28"/><w:color w:val="000000"/></w:rPr><w:t>${text}</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body>`
}

async function runCase(name, textLen, expectSeverity) {
  const buf = await buildDocx(makeBody(textLen))
  const p = path.join(os.tmpdir(), `bidtools-pc-${textLen}.docx`)
  fs.writeFileSync(p, buf)
  const facts = await collectDocxFacts(p)
  fs.unlinkSync(p)

  ok(facts.doc.page_count !== undefined, `${name}: page_count 已估算`, facts.doc.page_count)
  ok(facts.doc.page_count_estimated === true, `${name}: 标记为估算`, facts.doc.page_count_estimated)
  ok(facts.doc.page_count_source === 'estimated', `${name}: source=estimated`, facts.doc.page_count_source)

  const verdict = validateFacts(facts, { region: '河北省', industry: '工程' })
  const f = verdict.findings.find((x) => x.rule_id === 'DOC.PAGE_COUNT')
  if (expectSeverity === null) {
    ok(f === undefined, `${name}: 不触发 DOC.PAGE_COUNT`, f && f.severity)
  } else {
    ok(f !== undefined, `${name}: 触发 DOC.PAGE_COUNT`, verdict.findings.map((x) => x.rule_id))
    ok(
      f && f.severity === expectSeverity,
      `${name}: 严重度=${expectSeverity}`,
      f && f.severity,
    )
  }
  console.log(`     ${name}: 估算页数=${facts.doc.page_count}, 实际触发=${f ? f.severity : '无'}`)
}

async function main() {
  console.log('\n--- 页数估算：短文档（应不触发） ---')
  await runCase('short(2k字)', 2000, null)

  console.log('\n--- 页数估算：中等篇幅（约118页，临界→WARN） ---')
  await runCase('mid(100k字)', 100000, 'WARN')

  console.log('\n--- 页数估算：超长篇幅（约165页，远超→REJECT） ---')
  await runCase('huge(140k字)', 140000, 'REJECT')

  console.log(`\n=== pagecount smoke: ${pass} passed, ${fail} failed ===`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
