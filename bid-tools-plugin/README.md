# bid-tools-plugin — 标书写作确定性工具集（DSH 原生插件）

按 DSH 官方插件规范（npm bundle + cordis.patch.yml）实现的进程内插件，
对应标书六步流程的确定性环节，由 DSH「标书写作」技能编排调用。

| 六步流程 | 实现层 | 本插件 | 是否用 LLM |
|---------|--------|--------|-----------|
| ① 解析招标文件·规则抽取 | 本插件 | `tender_parse_constraints` | ❌ 纯正则 |
| ① 招标文件公平竞争审查 | 本插件 | `bid_check_fairness` | ❌ 纯正则 |
| ① 解析招标文件·语义补充 | 本插件 | `tender_extract_requirements` | ✅ |
| ② 生成章节大纲 | DSH 技能直调 LLM | — | ✅ |
| ③ 分章检索取材 | 本插件 | `kb_search_materials` | ❌ |
| ④ 分章生成长文 | DSH 技能直调 LLM | — | ✅ |
| ④ 生成后 PII 脱敏 | 本插件 | `bid_mask_pii` | ❌ 纯正则 |
| ⑤ 身份泄露扫描（八面） | 本插件 | `bid_scan_disclosure` | ❌ 规则包 |
| ⑤ 确定性规则引擎 | 本插件 | `bid_check_rules` | ❌ 规则包 |
| ⑤ 全量 docx 审计 | 本插件 | `bid_audit_docx` | ❌ OOXML 解析+规则包 |
| ⑤ 响应点偏离表 | 本插件 | `bid_check_compliance` | ⚠️ 规则为主+LLM 复核 |
| ⑤ FactCheck 事实溯源 | 本插件 | `bid_fact_check` | ❌ 启发式 |
| ⑤ 围串标/公平性自检 | 本插件 | `bid_check_collusion` | ❌ 纯算法 |
| ⑥ 人工审校（HITL）+ 归档回流 | 技能卡点 + 本插件 | `bid_archive_final` | ❌ |

> **红线**：合规判定绝不由 LLM 做出。LLM 只做内容生产与语义建议；
> 所有 REJECT/WARN 判定都来自确定性规则（可复现、可解释、可在行政复议中举证）。

> 另有 `bid-tools-mcp/`（Python MCP Server 版），工具契约与本插件完全一致，
> 可作为独立服务经灵知「外部连接」接入，两种形态二选一或并存。

## 工程结构（DSH bundle 规范）

```
bid-tools-plugin/
├── package.json        # ① 声明：dsh.bundle.patch 指向注册文件
├── cordis.patch.yml    # ② 注册：把 bid-tools 写进 DSH 配置树
├── tsconfig.json       # 已开启 resolveJsonModule，可直接 import 规则包 JSON
├── src/
│   ├── index.ts        # 插件入口：export name/inject + apply(ctx)，注册 16 个工具
│   ├── types.ts        # 工具契约类型（与 Python 版一一对应）+ 确定性模块类型再导出
│   ├── config.ts       # 环境变量集中管理（含规则引擎口径 RULE_*）
│   ├── llm.ts          # vLLM 客户端（JSON 容错提取 + 校验重试）
│   ├── ragflow.ts      # RAGFlow HTTP API（检索 / 上传归档）
│   ├── logic.ts        # 分块、证据定位、脏数据归一化
│   ├── parser.ts       # 【确定性】招标约束抽取（废标/格式/评分权重/资质/关键参数）
│   ├── pii.ts          # 【确定性】PII 脱敏 + 八面身份泄露扫描
│   ├── rules.ts        # 【确定性】规则引擎（registry+validator：口径匹配/判定/verdict）
│   ├── docxFacts.ts    # 【确定性】docx 几何事实采集（OOXML 解析，激活暗标几何规则）
│   ├── factcheck.ts    # 【确定性】FactCheck 事实溯源（无来源 -> 待人工补充）
│   ├── collusion.ts    # 【确定性】围串标/公平性自检（SimHash 雷同 + 报价规律）
│   ├── fairness.ts     # 【确定性】招标文件公平竞争审查（FAIR.* 9 类排斥限制竞争条款）
│   ├── facts.ts        # 【确定性】ProjectFacts 单一事实源（从需求抽取 12 类事实 + 一致性校验）
│   ├── render.ts       # 【确定性】OOXML 渲染导出（Markdown→.docx，jszip 直写）
│   ├── vendor.d.ts     # DSH 官方包类型桩（拿到真实包后删除）
│   └── data/           # 规则包与行业知识包（来自 AIBidForge 3.1+5.0，Apache-2.0/MIT 许可）
│       ├── rules/
│       │   ├── common_disclosure.json  # 通用身份泄露与元数据扫描（always-on，必挂）
│       │   ├── hebei_provincial.json   # 河北省级/雄安暗标口径
│       │   ├── hebei_baoding.json      # 保定市口径
│       │   ├── hebei_zhangjiakou.json  # 张家口市口径
│       │   └── hebei_transport.json    # 交通行业口径
│       ├── industries/                 # 11 个行业知识包（9 个来自 3.1，2 个来自 5.0）
│       │   └── water.json              # 水利水电行业知识包（河道治理/水库加固/灌区）
│       ├── fairness/
│       │   └── fairness_rules.json     # 9 条 FAIR.* 公平竞争审查规则（外置、可溯源）
│       ├── eval/
│       │   └── scoring_models.json     # 评分模型（12 否决前检查项+5 价格分算法+10 评分 profile）[5.0]
│       └── industry_detect.json        # 11 行业自动识别配置（关键词/业绩词/资质词）[5.0]
└── README.md
```

### 确定性规则包与行业包（来源）

`src/data/` 下的数据取自 **AIBidForge 3.1 与 5.0（atomgit，MIT/Apache-2.0，Copyright 2026 FullFrame AI）**，
未做语义改动，仅作为插件内置规则/知识资产：

| 文件 | 作用 | 在插件中的消费方 |
|------|------|-----------------|
| `rules/common_disclosure.json` | 17 条身份泄露+元数据规则（信用代码/手机/邮箱/银行/单位名/地址/人员/企业文化；creator/company/修订/批注/隐藏文字/rsid/图片EXIF/彩色） | `pii.ts` 的 `scanDisclosure`、`rules.ts` 的 always-on 叠加 |
| `rules/hebei_*.json` | 河北各地域暗标模板（字体/字号/行距/页边距/页数等，多为 OOXML 几何规则） | `rules.ts` 按 `region/city/industry` 口径匹配选中 |
| `industries/*.json` | **11 个行业知识包**（construction / epc / gov_procurement / it_informatization / material_equipment / mep / municipal / new_energy / transport / urban_renewal / water）。每包含 12± 章节大纲、5–8 工法、6–8 资质、6–8 评分点、7–10 规范、6–8 风险、3–4 模板。其中 `gov_procurement`（政府采购 87 号令口径）与 `it_informatization`（信息化与 IT）来自 AIBidForge5.0，其余 9 个来自 3.1 | 大纲生成的知识种子；**批量灌库步骤见下文「行业知识包建库」** |
| `eval/scoring_models.json` | 评分模型：12 个否决前检查项（P01-P12，形式/资格/符合性/双盲）+ 5 种价格分算法（基准价线性/最低价满分/合理低价/河北双随机）+ 10 个评分 profile（按行业×地区）[5.0] | `bid_precheck_bid`（否决前自检）+ `bid_score_price`（价格分测算） |
| `industry_detect.json` | 11 行业自动识别配置：每行业含 keywords（招标文件行业判定）/ performance（业绩相似度）/ qualifications（资质语义匹配）[5.0] | `tender_parse_constraints` 的 `detected_industry` 输出字段 |

> 规则引擎对"纯文本输入"（`bid_check_rules` 只传 `text`）时，字体字号页边距/页数等需要 OOXML 几何特征的规则会**静默跳过**（记为 skipped_rule_count），不误报；
> 但当以 **docx 文件**为输入时，应调用 `bid_audit_docx` —— 它先用 `docxFacts.ts` 解析 OOXML 补齐几何/元数据/痕迹/图片事实，
> 那 11 条暗标几何规则随即**全部参与判定**（干净文档 skipped=0）。其中 `DOC.PAGE_COUNT`（篇幅≤100 页）因 OOXML 不存真实页数，
> 由 `docxFacts.ts` 按字符密度**估算**：文档属性含真实页数则直接采信；估算值仅在"明显远超上限（>125%）"时判 REJECT，临界区间降级为 WARN，避免误废标（红线：不能证明违规就不判 REJECT）。这是河北暗标最易废标、此前被跳过的卡点，现已打通。

### 规则引擎口径配置

```
RULE_REGION=河北省          # 评标地域口径（默认河北省）
RULE_CITY=                  # 地市口径，空则不限
RULE_INDUSTRY=工程          # 评标口径行业（工程/房建/市政…），注意与知识库行业包区分
RULE_TENDER_TYPE=工程       # 标的类型
```

⚠️ 口径行业（`RULE_INDUSTRY`）决定**用哪套暗标模板**；知识库行业包（`water.json`）决定**用什么知识写作**，两者不是一回事。

## 行业知识包建库（industries/*.json → RAGFlow）

`industries/` 下的 11 个行业包是结构化知识种子。**要让 `kb_search_materials` 真正能检索到行业知识**，需把它们灌进 RAGFlow 建库。
脚本 `scripts/ingest-industries.mjs` 负责这件事：先把每个包扁平化为若干篇带 `tags` 的 Markdown 文档
（章节/工法/资质/评分点/规范/风险/模板各一篇，粒度细、检索更准），再建库 → 逐篇上传 → 轮询解析至 `DONE`。

```bash
# 1) 仅产出某包/全部包的扁平化语料（不碰 RAGFlow，可直接检视/评审，写入 <pack_key>_corpus/）
node scripts/ingest-industries.mjs --pack water --dry-run
node scripts/ingest-industries.mjs --all --dry-run

# 2) 真实灌库（需 RAGFlow v0.27.1 可达 + API Key；服务在本机 9380 或经端口转发）
#    --all：每个行业建一个独立知识库（标书知识库·<行业名>）；--pack <key>：单包，可用 --dataset-name 指定库名
RAGFLOW_BASE_URL=http://<host>:9380 RAGFLOW_API_KEY=<key> \
  node scripts/ingest-industries.mjs --pack water --dataset-name "水利标书知识库"
RAGFLOW_BASE_URL=http://<host>:9380 RAGFLOW_API_KEY=<key> \
  node scripts/ingest-industries.mjs --all

# 3) 灌库后抽样验证检索是否生效
RAGFLOW_BASE_URL=http://<host>:9380 RAGFLOW_API_KEY=<key> \
  node scripts/ingest-industries.mjs --pack water --verify "施工导流度汛方案"
```

建库成功后把返回的 `dataset_id` 回填到：

```
KB_DATASET_IDS=<dataset_id>      # 检索取材（kb_search_materials 命中来源）
BID_ARCHIVE_DATASET_ID=<dataset_id>  # 定稿归档回流（可选，复用同一库）
```

> 注：本开发机通常不跑 RAGFlow（服务在 Atlas NPU 部署机）。脚本已对"不可达"做优雅报错，
> 拿到部署机地址/端口转发后一把跑通即可。`RAGFLOW_BASE_URL` 默认已从 `http://127.0.0.1` 修正为
> `http://127.0.0.1:9380`（RAGFlow API 标准端口），不同部署改环境变量即可。
> 嵌入模型默认 `BGE-M3`（与我们的部署一致），可用 `RAGFLOW_EMBEDDING_MODEL` 覆盖。

## 安装与挂载

```bash
# 1. 把本目录放进 DSH 可访问的位置，在 DSH 中以 bundle 方式安装：
pnpm install file:/absolute/path/to/bid-tools-plugin
# 2. 重启 DSH；启动日志出现 "[bid-tools] 18 个工具注册完成" 即挂载成功
```

配置（环境变量，或在 DSH profile/settings 层注入）：

```
LLM_BASE_URL=http://<LLM服务器IP>:8000/v1
LLM_MODEL=qwen3.8-27b-awq
RAGFLOW_BASE_URL=http://<应用服务器IP>
RAGFLOW_API_KEY=<RAGFlow API KEY>
KB_DATASET_IDS=<历史标书库等 dataset_id，逗号分隔>
BID_ARCHIVE_DATASET_ID=<历史标书库 dataset_id>
```

## 上线前必做（RC 阶段风险）

1. **对照真实 DSH 版本校验 API**：本插件的 `vendor.d.ts` 是依据官方教程写的类型桩
   （插件 = `export name/inject + apply(ctx)`；工具 = `ctx.tools.register(defineTool({...}))`）。
   RC 阶段 API 可能变动——安装真实 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools` 后
   删除 `vendor.d.ts`，跑 `pnpm run typecheck` 按真实类型修正。依赖版本线对齐
   部署的 DSH 版本（白皮书提示 RC 期用 `^0.1.0-rc.x` 线）。
2. **RAGFlow 字段冒烟**：`/api/v1/retrieval`、`/api/v1/datasets/{id}/documents` 按
   部署的 0.27.1 核验（尤其 `chunks[].document_keyword/similarity`）。
3. **参数 schema 格式**：`parameters` 按 `{ name: { type, required, description } }`
   书写，若真实 DSH 要求 JSON Schema 格式，仅需调整 4 个工具的 parameters 声明。
4. **最小闭环优先**：先验 `tender_extract_requirements` + `kb_search_materials` 两个工具，
   跑通"解析→检索→生成"主线，再接合规自查与归档。

## 验证（必跑）

```bash
npm run typecheck    # TS 类型检查（含 vendor 类型桩）
npm run test:smoke   # 确定性模块回归测试：编译到 .smoke-out 后跑 100+ 条断言（含 59 个单元测试）
```

`test:smoke` 覆盖：招标约束抽取（废标/格式/评分权重/工期/保证金/限价）、PII 脱敏（含
「19 位纯数字银行账号不得被信用代码正则吃掉」这条回归）、八面泄露扫描、规则引擎
（REJECT/PASS 双向验证 + 纯文本输入时几何规则静默跳过）、docx 全量审计（现场构造违规/合规两份 docx，
验证 11 条暗标几何规则经 `docxFacts` 补齐事实后全部生效、干净文档 0 REJECT）、FactCheck 溯源、围串标自检
（SimHash bigram 分词 + 相同文本距离 0 + 近似文本判相似 + 道路/水库判差异明显 + 等差/等比报价规律命中 + 随机/不足样本不命中 + 雷同簇与风险等级编排）、招标文件公平竞争审查（FAIR.* 9 条规则加载 + BIASED 文本命中 5 类 HARD + CLEAN 零误报 + 命中可溯源 + docx 路径抽取同样命中 + requires_human_review 闸门）、规则包与水利包加载。
- `tests/integration-pipeline.cjs`：**16 工具七步流程串联集成测试 / 端到端 demo**。用合成「招标文件 + 投标草稿 + 多份投标文件」把 16 个工具按标书七步流程跑通确定性闭环，并打印逐步链路追踪与闭环汇总表。对依赖 LLM / RAGFlow 运行时的 4 个工具（`tender_extract_requirements`、`kb_search_materials`、`bid_check_compliance` 的 LLM 语义复核分支、`bid_archive_final`）以**离线桩**演示数据流转并明确标注，绝不伪造判定结果；其余 12 个确定性工具为真实调用。
- `tests/smoke-newtools.cjs`：**AIBidForge5.0 移植新工具冒烟测试（16 项）**。覆盖 `industryDetect`（11 行业加载/_meta 滤除/识别/pack_key 映射/回落）、`precheck`（12 项否决情形：签字盖章/多报价/超限价/超期/MANUAL 指引）、`scorePrice`（5 方法：AVG_DROP 基准价/线性扣分/最低价满分/合理低价区间/双随机矩阵/超限价否决）。

> 已修复的两个真实缺陷（勿回退）：
> 1. `vendor.d.ts` 顶部原为 Python 风格头（`# -*- coding: utf-8 -*-` / `"""`），
>    在 TS 中非法，会让整个类型桩解析失败。
> 2. PII 正则顺序：原先把「统一社会信用代码」放在「银行账号」之前，
>    18 位纯数字银行账号会被信用代码正则吃掉前 18 位并残留末位数字。
>    现在先匹配纯数字的银行/身份证，再匹配信用代码，且全部加 `\b` 词边界。

## 工具契约

与 Python MCP 版保持一致（契约不变、只换壳）。★ 标记为本次新增的确定性工具：

**原有 4 个**

- `tender_extract_requirements(tender_text, tender_name?)` → 要求清单 JSON（LLM 语义）
- `kb_search_materials(question, dataset_ids?, top_k?)` → 带来源素材列表 JSON
- `bid_check_compliance(requirements_json, draft_text)` → 响应点偏离表 JSON
- `bid_archive_final(file_path, project, client?, industry?, year?, result?)` → 归档结果 JSON

**★ 新增确定性 8 个（零 LLM）**

- `tender_parse_constraints(tender_text)` → `{reject_clauses, format_clauses, scoring_clauses, scoring_weights, qualifications, key_params, stats, disclaimer}`
- `bid_mask_pii(text)` → `{text, matches[{type,value}], count}`（身份信息 → `＊＊＊＊＊＊`）
- `bid_scan_disclosure(text, auto_mask?=true)` → `{leaks[{rule_id,name,severity,match,context,suggestion,auto_fixable,needs_review}], summary, leak_count, masked_text}`
- `bid_check_rules(text?, facts_json?, region?, city?, industry?, tender_type?)` → `{verdict: REJECT|WARN|PASS, score, findings[], summary, skipped_rule_count, explain}`
- `bid_audit_docx(docx_path, region?, city?, industry?, tender_type?)` → `{verdict, score, findings[], summary, skipped_rule_count, explain}`（解析 docx 几何/元数据/痕迹/图片后跑规则引擎，激活 11 条暗标几何规则）
- `bid_fact_check(section_text, citations_json?)` → `{total_sentences, factual_sentences, cited, uncited, placeholder_count, requires_human_review: true, items[{sentence,status: 已引用|待人工补充}]}`
- `bid_check_collusion(documents_json?, prices_json?)` → `{input_summary, text_similarity{pairs,risk_groups,risk_level}, price_pattern{detected,type,detail}, risk_level: HIGH|MEDIUM|LOW, requires_human_review: true, disclaimer}`（SimHash 文本雷同簇 + 报价等差/等比规律；仅作用于提供的文件/报价，不抓取外部数据）
- `bid_check_fairness(text?, docx_path?)` → `{engine_version, template, rules_loaded, hits[{rule_id,rule_name,category,type,severity,sentence,matched,message,suggestion,basis,source_url}], summary{total_hits,hard_count,soft_count,by_category,sentence_count,char_count,requires_human_review}, disclaimer}`（FAIR.* 9 类：限定品牌/地域业绩/本地分支/所有制/特定奖项/资质适配/排斥外地/倾向错敏词/指定交易工具；规则外置可溯源，提示性结论不替代法定审查）

**★ 新增确定性 4 个（ProjectFacts 单一事实源 + OOXML 渲染）**

- `project_facts_init(requirements_json, project_name?)` → `{facts{project_name,deadline,budget,currency,qualification_levels,qualification_types,score_weights,key_params,risk_clauses,format_clauses,scoring_clauses,required_docs,personnel_requirements}, fact_count, version, initialized_at}`（从需求抽取结果自动提取 12 类事实，建立单一事实源）
- `project_facts_update(facts_json, updates, version?)` → `{facts, fact_count, version, updated_keys[], consistency_report}`（增量更新事实表，返回一致性校验报告）
- `project_facts_check(facts_json, document_text)` → `{consistency_report{consistent, violations[], warnings[], checked_count}, fact_usage}`（校验文档内容与事实表是否一致，如工期/预算/资质匹配）
- `bid_render_docx(markdown_text, output_path?, metadata?)` → `{output_path, byte_count, sections, paragraphs, tables, images, warnings[]}`（Markdown→.docx，jszip 直写 OOXML；支持标题/段落/列表/表格/加粗/斜体/页眉页脚/元数据；无需 Word 安装）

**★ 新增确定性 2 个（AIBidForge5.0 移植：否决前自检 + 价格分测算）**

- `bid_precheck_bid(draft_text, control_price?, required_duration_days?, industry?, tender_type?)` → `{industry, items[{code,item,category,severity,status,basis,detail,next_action}], summary{pass,warn,reject_risk,manual}, disclaimer}`
- `bid_score_price(prices, method?, full_score?, control_price?, params?, unit?)` → `{method, method_name, method_desc, unit, full_score, base_price{value,algorithm,algorithm_desc,notes}, params, scores[{price,score,rank,notes}], candidate_matrix[{algorithm,base_price,scores}], disclaimer}`

### bid_precheck_bid 详细说明

**用途**：投标定稿前对草稿做 12 项否决情形自检（P01-P12），对应评标委员会符合性审查的否决条款。
确定性规则直接判定，零 LLM；不可自动判定项标 `MANUAL` 并指引对应工具。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `draft_text` | string | 是 | 标书草稿全文（或待自检章节全文） |
| `control_price` | number | 否 | 最高投标限价（元）。传入后自动核对报价是否超限价（P05） |
| `required_duration_days` | number | 否 | 招标要求的工期（日历天）。传入后自动核对工期承诺（P12） |
| `industry` | string | 否 | 评标行业（材料设备/新能源适用 ★号参数规则 P11），可用 `tender_parse_constraints` 返回的 `detected_industry.name` |
| `tender_type` | string | 否 | 标的类型（工程/货物/服务） |

**示例**：

```
bid_precheck_bid({
  draft_text: "我方投标报价为920万元，工期115日历天，已缴纳投标保证金20万元。联合体投标：否。",
  control_price: 9800000,
  required_duration_days: 120,
  industry: "信息化与IT"
})
```

**输出字段释义**：

| 字段 | 说明 |
|------|------|
| `industry` | 本次自检使用的行业（影响 P11 ★号参数规则是否生效） |
| `items[].code` | 检查项编号 P01-P12（签字盖章/联合体协议/资格条件/唯一报价/限价成本/实质响应/串标作假/保证金/暗标泄露/暗标格式/★号参数/工期质量） |
| `items[].status` | `PASS`（通过）/ `WARN`（有风险）/ `REJECT_RISK`（否决风险）/ `MANUAL`（不可自动判定，需人工或工具确认） |
| `items[].basis` | 判定依据（规则条款出处） |
| `items[].detail` | 判定详情（含抽取到的报价/工期数值） |
| `items[].next_action` | MANUAL 项的工具指引（如 P06→`bid_check_compliance`、P07→`bid_check_collusion`、P09→`bid_scan_disclosure`、P10→`bid_audit_docx`） |
| `summary` | 四类状态计数（pass/warn/reject_risk/manual 之和恒为 12） |

**注意**：`REJECT_RISK` 项必须整改后才能投标；`WARN` 项建议整改；`MANUAL` 项按 `next_action` 指引调用对应工具或人工确认。

### bid_score_price 详细说明

**用途**：按评标办法复算各家报价的价格分（确定性公式复算，零 LLM 零随机）。
支持 5 种方法；含超限价否决检查（《招标投标法实施条例》第 51 条第 5 项）。

**参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prices` | number[] | 是 | 全部有效报价数组，如 `[920, 935, 950]`（单位与 `unit` 一致） |
| `method` | string | 否 | `BASE_PRICE_LINEAR`（默认，基准价线性扣分）/ `LOWEST_FULL`（最低价满分）/ `BASE_PRICE_RATIO`（基准价比率）/ `REASONABLE_LOW`（合理低价下浮区间）/ `HEBEI_DUAL_RANDOM`（河北双随机） |
| `full_score` | number | 否 | 价格分满分，默认 100 |
| `control_price` | number | 否 | 最高投标限价（与报价同单位）。传入后做超限价否决检查 |
| `params` | object | 否 | 覆盖默认算法参数：`base`（基准价算法，默认 AVG_DROP）/ `drop_n`（去高去低价个数，默认 1）/ `above_penalty`（每高 1% 扣分，默认 1）/ `below_penalty`（每低 1% 扣分，默认 0.5）/ `lower_pct`/`upper_pct`/`out_penalty`（合理低价区间参数） |
| `unit` | string | 否 | 报价单位：`万元`（默认）/ `元` |

**5 种方法的差异**：

| method | 算法 | 基准价默认算法 |
|--------|------|----------------|
| `BASE_PRICE_LINEAR` | 以基准价为中心，每高于 1% 扣 `above_penalty` 分、每低于 1% 扣 `below_penalty` 分，扣完为止 | `AVG_DROP`（去掉 n 个最高价和 n 个最低价后取平均） |
| `LOWEST_FULL` | 最低价得满分，其余按比例得分 | — |
| `BASE_PRICE_RATIO` | 报价/基准价 × 满分 | `AVG_ALL`（全体平均） |
| `REASONABLE_LOW` | 基准价下浮区间内得满分，超区间按 `out_penalty` 扣分 | `AVG_DROP` |
| `HEBEI_DUAL_RANDOM` | 河北双随机：随机抽取基准价算法。**工具不代抽取**，输出全部候选算法的得分矩阵供现场查表 | 输出 `candidate_matrix` |

**示例**：

```
bid_score_price({
  prices: [920, 935, 950, 890, 910],
  method: "BASE_PRICE_LINEAR",
  control_price: 980,
  unit: "万元"
})
```

**输出字段释义**：

| 字段 | 说明 |
|------|------|
| `base_price.value` | 计算出的评标基准价 |
| `base_price.algorithm` | 基准价算法代号（AVG_DROP/AVG_ALL/AVG_DROP_LOWER/MIN_PRICE/CONTROL_WEIGHT）；招标文件未提供算法时按降级链回落并在 `notes` 注明 |
| `base_price.notes` | 算法降级说明（如「未提供最高限价，CONTROL_WEIGHT 降级为全体平均」） |
| `scores[].price/score/rank` | 各家报价的得分与排名（得分降序）；超限价报价得 0 分、rank=0 并注明否决 |
| `scores[].notes` | 得分明细（如「低于基准价 1.16%，每 1% 扣 0.5 分」） |
| `candidate_matrix` | 仅 `HEBEI_DUAL_RANDOM` 方法有值：每个候选基准价算法下的各家得分矩阵，供评标委员会现场抽取后查表 |
| `disclaimer` | 固定免责声明：本测算为确定性公式复算，仅用于投标报价策略参考；评标基准价与得分以评标委员会现场计算为准 |

**注意**：`HEBEI_DUAL_RANDOM` 不代评标委员会做随机抽取（随机不可复现），只输出全部候选算法的得分矩阵——现场抽中哪个算法，直接查表即可。

**推荐编排顺序**（技能层串联）：

```
tender_parse_constraints      # ① 先跑确定性规则，锁定废标/格式/评分红线 + 自动识别行业（detected_industry）
  → bid_check_fairness           # ① 招标文件公平竞争审查（FAIR.* 9 类排斥限制竞争条款）
  → tender_extract_requirements  # ① 再做 LLM 语义补充
  → project_facts_init           # ①.5 从需求建立单一事实源（12 类事实自动提取）
  → bid_score_price              # ② 报价策略：按评标办法复算各报价的价格分，选定报价策略
  → kb_search_materials          # ③ 检索取材（来源即后续 FactCheck 依据）
  → [LLM 生成章节]
  → project_facts_check          # ③.5 生成内容与事实表一致性校验
  → bid_mask_pii                 # ④ 生成即脱敏
  → bid_precheck_bid             # ④.5 评标前否决项自检（P01-P12），REJECT_RISK 项先整改
  → bid_scan_disclosure          # ⑤ 身份泄露扫描
  → bid_check_rules              # ⑤ 规则引擎判定（元数据/痕迹/图片）
  → bid_audit_docx               # ⑤（定稿后）对 docx 做全量几何审计，堵住字体/页边距/页眉页脚/水印等格式废标点
  → bid_fact_check               # ⑤ 事实溯源，无来源标「待人工补充」
  → bid_check_compliance         # ⑤ 对照要求清单逐条核查
  → bid_check_collusion          # ⑤（多份标书/报价时）围串标/公平性自检：雷同底稿 + 报价规律
  → [人工审校 HITL]
  → bid_render_docx              # ⑥ Markdown→.docx 渲染导出（OOXML 直写）
  → bid_archive_final            # ⑥ 归档回流
```

设计原则不变：确定性步骤代码化（可测试、可复现、可审计），生成性步骤留给 LLM，
关键结论带 schema 校验与来源溯源，最终结论经人工审校确认。
