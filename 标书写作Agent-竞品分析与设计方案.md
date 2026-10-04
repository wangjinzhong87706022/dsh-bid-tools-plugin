# 标书写作 Agent 项目：13 篇公众号文章 + 开源代码 借鉴分析与设计方案

> 分析日期：2026-09-29
> 方法：用 `opencli weixin download` 抓取 13 篇微信公众号文章为 Markdown；克隆 3 个开源仓库到 `E:\git\biaoshu` 并做代码分析
> 目标：为「灵知（Lingzhi）平台上的标书写作 Agent」提炼可复用范式，给出落地到 **DSH + RAGFlow 0.27.1 + AGP + Qwen3.8-27B（三服务器架构）** 的设计方案与实施步骤

---

## 0. 分析过程与产出物

| 动作 | 产出 | 位置 |
|---|---|---|
| opencli 抓取 13 篇公众号文章 | 13 份 Markdown | `C:\Users\Administrator\WorkBuddy\2026-09-23-13-38-18\weixin-articles\` |
| 克隆开源代码 | AIBidForge2.0（atomgit, MIT） | `E:\git\biaoshu\AIBidForge2.0` |
| 克隆开源代码 | 易标 AI / biaoshu-ai（gitcc） | `E:\git\biaoshu\biaoshu-ai` |
| 克隆开源代码 | docassemble（github, MIT） | `E:\git\biaoshu\docassemble` |
| 克隆开源代码（维护版） | AIBidForge3.1（atomgit, MIT） | `E:\git\biaoshu\AIBidForge3.1`（clone 完成，已完成代码分析，见 §9）|

**关键发现先讲结论**：13 篇里真正"代码级可借鉴"的是 **AIBidForge2.0**（一套完整、可运行、MIT 协议的投标合规生产系统），它的**总设计原则与我们"离线放开、在线收敛、LLM 为在线关键推理红线"完全同构**——它明文写"合规判定一律由确定性规则引擎执行，模型结论不替代法定责任"，并且**内置 9 大行业知识包，其中包含「水利水电」**。

---

## 1. 13 篇文章速览与归类

| # | 文章主题 | 类型 | 可借鉴核心 |
|---|---|---|---|
| 1 | AI 智能标书写作助手开源（易标 AI） | 开源工具 | Electron+Vite+React+TS；MinerU 解析；KB 复用；Mermaid；废标检查+查重；后台任务恢复 |
| 2 | 别再为废标熬夜（AIBidForge2.0 开源） | 开源工具+架构 | 投标合规生产系统；FastAPI+原生前端；确定性规则引擎；MIT；离线可跑 |
| 3 | WorkBuddy「标书技术方案生成大师版」 | 方法论/产品 | **评分点驱动大纲**；自定义页码（按页数反推字数）；内置行业库；三重自检（防杜撰/一致性/终检回补） |
| 4 | 3000 页标书是"组装"出来的 | 方法论 | 900 组装+1800 改写+300 格式；**开工前四张表+页面预算表**；商务组装/技术改写；**三轮核对收口** |
| 5/6/7 | 筑标 AI·BidForge 开发方案（上/中/下） | 系统设计 | 最完整的投标 AI 平台设计文档（政策映射、架构、暗标引擎、围串标自检、实施路线） |
| 8 | 用 WorkBuddy 做 AI 审标 Skill | 方法论 | 审标五步法；四类风险（形式/资信/经济/技术）；Skill 化固化经验 |
| 9 | docassemble 把标书变"点选填空" | 开源范式 | 专家系统/文档装配；YAML 问卷+变量单一事实源；改一处全篇同步 |
| 10 | 不搭大模型不用 skill 的网站生成 1000 页 | 商业化思路 | 拆模块（20-30 页/模块）；知识库三层；术语表+项目事实表单一事实源；合规质检+查重 |
| 11 | AI 审标七步法（附提示词） | 方法论/提示词 | **七步法**：通读→资格→否决条款→评分拆解→合同风险→形式核对→响应矩阵 |
| 12 | 某工程集团投标 Agent + RAG 检索系统设计 | 系统设计 | 读标→拆解→检索→生成→审校→归档闭环；混合 RAG（全文+向量+知识图谱）；响应矩阵 |
| 13 | 820 页标书长上下文省钱实测 | 工程验证 | **1M 窗口可整篇喂**；缓存命中计费省 92%；有效窗口打 4-6 折；**印证我们 128K 选型** |

---

## 2. 开源代码分析（E:\git\biaoshu）

### 2.1 AIBidForge2.0（重点，atomgit，MIT）—— 直接可借鉴

**定位**：面向河北"双盲"评审的"投标合规生产系统"（非"AI 代写"）。与我们的红线一致：AI 只做内容生产，废标/格式判定走确定性规则。

**技术栈**：Python 3.11 · FastAPI · SQLAlchemy 2.0 · python-docx · lxml；原生 HTML/CSS/JS 单页（PyInstaller+InnoSetup 打包桌面端）；SM3 国密审计链；SimHash 相似度。

**目录（apps/api/）**：
```
main.py                # 入口（lifespan 建表+导入种子）
core/                  # config / db / sm3 / audit / industry / llm_config / tenant
modules/
  tender_parser/       # 招标文件解析（确定性正则抽取）
  generation/          # 章节生成编排 + LLM 适配器
  docx_engine/         # 暗标 OOXML 渲染 + 元数据清洗
  rules/               # 口径匹配 + 确定性校验引擎
  evaluation/          # 内测评标引擎
  collusion/           # SimHash 文档相似度
  knowledge/           # 知识库存储/检索/运营
data/industries/       # 9 大行业知识包（JSON 种子，含「水利水电」）
data/rules/            # 河北 4 套暗标口径 + 通用披露规则
routers/               # system/projects/tender/generation/docx/evaluation/...
```

**行业知识包（9 大行业 448 条）**：建筑工程 · 市政道路与给排水 · **水利水电** · 机电安装与装饰装修 · 新能源 · 城市更新 · 材料设备采购 · 公路交通 · EPC 工程总承包。每个含：章节骨架 / 工法库 / 资质要求 / 法规标准 / 评分要点 / 风险点 / 技术方案模板。**这是水利场景的直接可复用资产。**

**关键代码剖析**：

`modules/generation/orchestrator.py` —— 生成编排范式
- 链路：`检索知识资产` → `组装约束上下文` → `LLM 撰写（失败回退确定性引擎）` → `输出内容层语义 JSON` → `DocxEngine 渲染`
- 红线注释："合规判定不在本模块，本模块只产出内容"
- `_context_from_knowledge()`：从知识库取 outline/methods/templates/risks/score_points/regulations
- `_build_prompt()`：把「章节要点 / 编写指引 / 常见扣分陷阱 / 工法 / 评分要点 / 风险 / 模板」拼成强约束提示词，并要求**严格输出 JSON**（title + blocks[heading/paragraph/bullet/table]）
- `_deterministic_content()`：无 LLM 凭据时把知识库骨架+要点组装成结构化 JSON（"可编辑骨架"）
- `_sanitize()`：正则把手机号/邮箱/统一社会信用代码替换为 `＊＊＊＊＊＊`
- `generate_section()`：`want_llm = llm._available()`，**LLM 调用异常即回退确定性引擎**；返回 `provider / word_count / ai_contribution(0.85|0.35) / requires_human_review=True`

`modules/generation/llm.py` —— 可插拔 LLM 适配器（OpenAI 兼容）
- SYSTEM_PROMPT 明确边界：①只写内容 ②不做合规判定 ③不编造资质/业绩/证书 ④身份信息写 `＊＊＊＊＊＊` ⑤纯文本 JSON
- ⚠️ **关键工程坑**：`httpx.Client(trust_env=False)` —— 因为本环境注入了 HTTP_PROXY，默认会走代理导致外部调用失败。**我们的环境也有 7897 代理，调模型 API 时必须同样 `trust_env=False`，否则 vLLM/OpenAI 兼容接口会被本地代理拦截。**
- `chat_json()`：POST `/chat/completions`，能解析 ```` ```json ```` 围栏

`modules/tender_parser/extract.py` —— **纯确定性、不调 LLM** 的招标文件解析
- `extract_text()`：docx(Python-docx)/pdf(PyMuPDF)/txt
- 关键词+正则抽取：废标/否决条款、暗标格式要求、评分权重（技术/商务/价格/资信/业绩 X分或X%）、资质业绩、关键参数（工期/保证金/最高限价）
- 返回结构化 `ConstraintSet`（reject_clauses / format_clauses / scoring_weights / qualifications / key_params / stats）

`docs/AIBidForge-开发方案.md` —— 1026 行完整设计文档，含：
- **三层格式模型**：内容层(JSON) / 样式层(StyleSpec，由 ConstraintSet 编译) / 渲染层(直写 OOXML)，不复用 Word 样式名避免漂移
- **暗标 HARD/SOFT 规则 JSON**（PAGE.SIZE / FONT.FAMILY / LINE.SPACING / MARGIN / NO.HEADER / COLOR.BAN / PAGE.LIMIT 等），渲染后回读校验、最多 3 轮自修正
- **八面身份泄露扫描**：正文/特有标识/图表/文档属性/修订批注/隐藏内容/页眉页脚/PDF 元数据
- **多智能体编排**：Parser→Planner→Retriever→Writer→FactCheck→Compliance→Blind→Validator(非LLM)
- **RAG 与引用溯源**：BGE-M3 召回 Top-50 → BGE-Reranker-v2 精排 Top-8 → FactCheck 字符级比对 → 引用强制
- **多模型路由与降级**：主/备/兜底 + 熔断 + 降级为"模板填充+人工"

**可直接"抄"的部分**（映射到我们的 DSH Agent，仅作范式参考，不搬单体）：
- 行业知识包 JSON schema（章节骨架/工法/资质/评分要点/风险/模板）
- 招标解析的正则+关键词清单、ConstraintSet 结构
- PII 脱敏正则与 `＊＊＊＊＊＊` 占位约定
- 暗标 HARD 规则 JSON 模型（我们要做"水利标书格式合规"可复用同一模型）
- SM3 审计链、AI 标识（显式+隐式元数据）实现思路

### 2.2 易标 AI / biaoshu-ai（gitcc，Electron）—— 前端/UX 参考
- 技术栈：Electron（Win/macOS）+ Vite + React + TypeScript + Radix UI；electron-builder
- 能力：本地解析+MinerU 深度解析；评分点/资质/废标项提取；目录自动生成；技术方案生成；KB 复用；Mermaid 预览；废标检查+查重；后台任务恢复
- **对我们的价值**：桌面端 UX 范式（上传→解析→生成→自查→导出）；"任务持续落盘、关页面不丢进度"的韧性设计值得在灵知工作台上借鉴。后端逻辑我们不自研，走 DSH Agent。

### 2.3 docassemble（github，MIT）—— 结构化填空范式参考
- 专家系统/文档装配引擎：YAML+Markdown 写问卷，Python 写逻辑；字段定义为**变量单一事实源**，所有段落引用它，改主体一处全篇同步；支持 PDF/DOCX/RTF、触摸签名、多语言、后台任务
- **对我们的价值**：解决"法人/信用代码/工期/人员散落多页、手改必漏"的一致性难题 —— 对应文章 10 的「术语表+项目事实表」单一事实源。我们的生成编排应维护一份 `项目事实表(Project Facts)` 贯穿全册。

---

## 3. 对「标书写作 Agent 项目」的借鉴（映射到 DSH+RAGFlow+AGP）

> 我们的底座已定：灵知平台 + DSH Agent（Docker）+ RAGFlow 0.27.1 + AGP（数据底座）+ Qwen3.8-27B（2×4090）+ 解析服务器（1×4090，MinerU+VLM）+ 应用服务器（CPU 跑 RAGFlow+agent）；128K 上下文；BGE-M3（CPU）+ BGE-Reranker（GPU）。与研发隔离、私有化。

| 维度 | 借鉴点（来自文章/代码） | 在我们的 Agent 里怎么落地 |
|---|---|---|
| **总体范式** | AIBidForge「规则优先于生成」「AI 只做内容、合规确定性」（文章2/5/7代码） | DSH Agent 系统提示写死边界：生成工具只产出内容 JSON；合规/废标/格式校验走**确定性 Tool**（Python），不调 LLM。这正是"在线收敛、LLM 为红线" |
| **流程闭环** | 读标→拆解→检索→生成→审校→归档（文章4/12）；评分点驱动大纲（文章3）；响应矩阵（文章11）；三轮核对（文章4） | 编排为 DSH 多 Agent / Skill 串：解析Agent→规划Agent→检索Agent→写作Agent→审标Agent→归档Agent |
| **招标解析** | AIBidForge `tender_parser` 确定性抽取（文章2代码） | RAGFlow deepdoc/MinerU 做语义解析 + **确定性预抽取 Tool 兜底**（废标词表/评分权重正则），产出 `ConstraintSet` 存 AGP |
| **知识库** | 9 行业含水利水电知识包（文章2代码）；RAGFlow 知识库（已定） | 在 RAGFlow 建「水利标书行业知识包」：章节骨架/工法库/资质要求/法规标准/评分要点/风险点/模板，种子直接参考 AIBidForge 的 JSON |
| **生成编排** | 内容层JSON + OOXML 确定性渲染（文章5/7）；评分点驱动（文章3）；防杜撰（文章3/4坑一） | Writer Agent 输出**内容层 JSON**（非 Markdown）；FactCheck Tool 强制引用（抗幻觉）；模板/项目参数替换式"改写"而非"裸写" |
| **长上下文** | 文章13：820页整篇喂+缓存命中省92%，印证 128K | 我们的 128K 选型被文章13反向验证合理；超长文档用"全量+前缀缓存"或切 3-5 段精读后汇总互查 |
| **一致性** | 文章4/9/10：术语表+项目事实表单一事实源 | 维护 `ProjectFacts`（工期/人员/参数/承诺），所有章节引用，改一处同步 |
| **审标/合规** | 文章8 五步法、文章11 七步法、文章2 确定性校验引擎 | 审标 Agent = 确定性 Tool 做响应矩阵比对（废标项 vs 成稿 / 评分点 vs 页数 / 格式装订）+ 历史对比 diff |
| **韧性** | AIBidForge 无 LLM 回退确定性引擎（代码）；`trust_env=False`（代码） | 模型不可用时降级"模板填充+人工"；**调 Qwen3.8-27B API 时设 `trust_env=False` 绕过 7897 代理** |
| **导出与留痕** | 文章2/5：python-docx+lxml 直写 OOXML；SM3 审计链；AI 标识 | 导出 Tool 用 python-docx 直写（不依赖 Word 样式名）；AGP 存审计链；导出标"AI 辅助生成，已人工确认" |

---

## 4. 标书写作 Agent 设计方案

### 4.1 定位与边界（辅助性定位，必须写进红线）
- **定位**：灵知平台上的「投标合规生产辅助 Agent」——读标、拆解、检索、生成初稿、审校、归档，**最终出件须人工确认签认**。
- **红线（产品级，参考 AIBidForge 附录C）**：不代投、不代签、不代管 CA、不编造资质/业绩/人员；合规判定确定性、不依赖 LLM；所有生成可溯源、可审计。

### 4.2 总体架构（复用已定的三服务器）
```
[应用服务器 CPU]  RAGFlow 0.27.1 + DSH Agent 编排（灵知工作台）
        │
[解析服务器 1×4090]  MinerU + VLM（公式/图片/竖表） + 确定性预抽取 Tool
        │
[LLM 服务器 2×4090]  Qwen3.8-27B (vLLM, TP=2, 128K)  ← 调 API 时 trust_env=False
        │
[AGP 数据底座]  招标解析ConstraintSet / 项目事实表 / 行业知识包(RAGFlow) / 资质业绩(企业库) / 审计链
        │
[BGE-M3 CPU + BGE-Reranker GPU]  RAG 检索
```

### 4.3 模块设计（5 个 Agent + 确定性 Tool 层）
1. **解析 Agent**：RAGFlow deepdoc/MinerU 解析 → 确定性预抽取 Tool（废标词表/评分权重正则）→ 产出 `ConstraintSet`（含来源定位 page/paragraph），落 AGP。
2. **知识库 Agent**：RAGFlow 知识库 = 水利行业知识包（章节骨架/工法/资质/法规/评分要点/风险/模板）+ AGP 企业资质/业绩/人员。检索走 BGE-M3+Reranker。
3. **生成编排 Agent**（评分点驱动）：
   - Planner：按招标文件目录/评分项生成大纲（逐条对齐，缺失=漏项风险）
   - Retriever：混合检索（知识包+企业库+项目上下文）
   - Writer：**输出内容层 JSON**（heading/paragraph/bullet/table），引用强制
   - FactCheck Tool：每条断言必须带引用，无源标"待人工补充"（杜绝编造业绩/资质）
   - Compliance Tool：过滤绝对化用语/超范围承诺
   - 脱敏：身份信息→`＊＊＊＊＊＊`
   - Render Tool：python-docx 直写 OOXML（内容/样式分离，不依赖样式名）
4. **审标 Agent**：响应矩阵比对（废标项 vs 成稿 / 评分点 vs 页数 / 格式装订）+ 历史中标 diff，输出**问题清单**（等级/位置/依据/修改建议），不改稿只报问题。
5. **归档 Agent**：AGP 持久化 + 审计链（SM3）+ AI 标识（显式角标+隐式元数据）+ 15 年留存。

### 4.4 关键设计决策（10 条，带出处）
1. 内容层 JSON + 样式层分离渲染（AIBidForge 5.1）→ 避免 Markdown→docx 格式漂移
2. 引用强制 + FactCheck（AIBidForge 5.5 / 文章4 坑一）→ 抗幻觉
3. 评分点→响应矩阵→页面预算（文章3/4）→ "说几页写几页"，评分专家对号入座
4. 128K 全量+前缀缓存（文章13）→ 印证选型，长文省成本
5. 无 LLM 回退确定性引擎（AIBidForge 代码）→ 韧性
6. `trust_env=False`（AIBidForge llm.py）→ **绕过本地 7897 代理调模型**
7. 项目事实表单一事实源（文章9/10）→ 跨章节一致性
8. 合规判定确定性、不走 LLM（贯穿文章2/5/7）→ 可复现可举证
9. 人工确认点（生成完成/自查通过/校验通过/导出前）（AIBidForge M12）→ 落实辅助性定位
10. 暗标/身份泄露/元数据清洗（文章2/5）→ 即便水利标书非暗标，"身份泄露+引用溯源+留痕"通用

### 4.5 DSH 落地形态（延续此前结论：DSH 原生 plugin）
- 以 **DSH Skill 编排**串联流程；**确定性步骤用 DSH Tool（plugin/MCP）** 承载（解析预抽取、FactCheck、Compliance、OOXML 渲染、审标比对、脱敏）。
- 之前已生成的 `bid-tools-plugin`（TS/npm 形态）即承载这些 Tool；本文的借鉴用于**充实 Tool 内部规则与提示词**。

---

## 5. 实施步骤（分阶段，可落地）

| Phase | 目标 | 交付 / 工具 | 验收 |
|---|---|---|---|
| **P0 环境与知识库** | 三服务器就位；建水利行业知识包 | RAGFlow 知识库 + AGP；参考 AIBidForge `data/industries` 水利水电 JSON 做种子 | 知识包可检索；9 类资产（骨架/工法/资质/法规/评分/风险/模板）入库 |
| **P1 招标解析 + ConstraintSet** | 上传招标文件→结构化约束集 | RAGFlow deepdoc/MinerU + 确定性预抽取 Tool（复用 AIBidForge 正则/词表） | 输出 ConstraintSet（废标/评分权重/资质/关键参数+来源定位）；低置信转人工 |
| **P2 生成编排 Agent** | 评分点驱动大纲→逐章生成内容层 JSON | DSH Skill + Writer/FactCheck/Compliance/Render Tool | 单章可生成；引用率 100%；无编造业绩；导出 docx 格式保真 |
| **P3 审标 Agent** | 响应矩阵 + 三轮核对 | 审标 Tool（废标vs成稿/评分vs页数/格式装订 + 历史 diff） | 输出问题清单（等级/位置/依据/建议）；不改稿 |
| **P4 导出与归档** | Word 导出 + 审计留痕 | python-docx 直写 Tool + AGP 审计链 + AI 标识 | 导出含显式标识+隐式元数据；审计链可验证 |
| **P5 合规红线与人工确认** | 4 个确认点 + 产品红线 | DSH 工作流钩子 | 4 确认点不可跳过；无代投/代签/编造功能 |

---

## 6. 风险与对策

| 风险 | 对策（出处） |
|---|---|
| 幻觉编造业绩/资质（文章4 坑一） | FactCheck 引用强制 + 无源即"待补"占位 + 人工确认 |
| 长文档跨章节不一致（文章13） | 项目事实表/术语表单一事实源；生成后一致性 Tool 校验 |
| 代理导致模型 API 调用失败 | 调 Qwen3.8-27B 设 `trust_env=False`（AIBidForge 实证坑） |
| 格式在 WPS/Word 漂移 | OOXML 直写、不依赖样式名、渲染后回读校验 |
| 合规争议 | 严守辅助性定位、4 确认点、全程留痕作为尽责证据 |
| 规则过时（政策变更） | 规则声明式配置 + 版本化 + 政策观察队列（AIBidForge R1） |

---

## 7. 代码复用清单（具体到文件）

- **AIBidForge2.0** 可直接参考：
  - `apps/api/modules/tender_parser/extract.py` —— 正则/关键词清单、ConstraintSet 结构
  - `apps/api/modules/generation/orchestrator.py` —— 内容层 JSON 结构、提示词组装、`_sanitize` 脱敏
  - `apps/api/modules/generation/llm.py` —— `trust_env=False`、SYSTEM_PROMPT 边界
  - `apps/api/data/industries/` —— 水利水电等行业知识包 JSON schema（种子）
  - `apps/api/modules/rules/validator.py` + `docs/...开发方案.md §5.1` —— HARD/SOFT 规则 JSON 模型
- **docassemble** 参考：变量单一事实源问卷范式（解决跨页字段一致性）
- **不建议直接搬**：AIBidForge 的 FastAPI 单体 → 我们走 DSH Agent 编排；它的桌面前端 → 我们走灵知工作台

---

## 8. 后续建议
1. **AIBidForge3.1**（维护版，含账号权限/种子数据/容器化/全量回归）已克隆到 `E:\git\biaoshu\AIBidForge3.1` 并完成代码分析，详见 **§9 AIBidForge3.1 差异分析（对照三服务器部署）**。
2. 优先把 **水利水电行业知识包 JSON** 从 AIBidForge2.0 迁移为 RAGFlow 知识库种子 —— 这是投入最小、对标书质量提升最直接的借鉴。
3. 把 `bid-tools-plugin` 的 Tool 内部规则，按本文 §7 列表逐步充实（先 parser 正则 + 脱敏 + FactCheck）。

> 说明：本文为分析+设计方案，未自动生成 Word/PDF。如需我把它整理成 `.docx`（沿用此前灵知部署方案的版式）或拆分成分阶段任务卡，告诉我即可。

---

## 9. AIBidForge3.1 差异分析（对照三服务器部署）｜补遗 2026-09-30

> 补遗说明：§8 第 1 条的待办项。AIBidForge3.1（atomgit，MIT，Copyright 2026 FullFrame AI / 全帧派）已克隆至 `E:\git\biaoshu\AIBidForge3.1` 并完成代码分析。下文聚焦「与我们三服务器方案有哪些差异、哪些能直接抄、哪些不要抄」。

### 9.0 一句话结论

AIBidForge3.1 是 2.0 的**工程化升级版**：从单体 FastAPI 应用演进为 **monorepo + docker-compose 多 profile（主平台 + 3 个业务微服务 + 可选 PostgreSQL 多租户）+ 全量回归测试**。它的**确定性合规引擎（rules 三件套 + 规则 JSON）和水利行业知识包 `water.json` 是我们最该直接复用的资产**——前者可直接做我们「确定性 Tool 层」的底座，后者可直接当 RAGFlow 水利知识包种子。它的「三个服务」（报价/文档/出件）是**业务微服务**，与我们「三台物理服务器」（应用/解析/LLM）**不是一回事**，切勿混淆。

### 9.1 3.1 是什么：从单体到容器化 monorepo

`docker-compose.yml` 要点：
- **主平台 `bidplatform`**：构建当前目录，`8000` 端口；首次启动自动建 `admin` 账号，口令写入挂载卷 `INITIAL_PASSWORD.txt`。
- **三个业务微服务（需 `--profile services` 启动）**：
  - `bidquote`（8101，报价测算）、`biddocsense`（8102，文档智能，含 OCR tesseract+chi_sim）、`bidsubmit`（8103，出件递交）。
  - 三者共用一把 `SERVICE_API_KEY`，主平台凭它拉取数据；`depends_on` 设为 `required:false`——**未启动则自动降级为「未配置」**，主平台仍可独立运行。
  - 三个服务各自 SQLite 持久化（`bidquote_data` 等命名卷）。
- **可选 `postgres`（需 `--profile pg`）**：生产多租户改用 PostgreSQL（注释里给出 `BIDPLATFORM_DATABASE_URL` 切换方式）。
- **生产前强制项**（compose 注释明示）：`BIDPLATFORM_SECRET_KEY` / `BIDPLATFORM_AUDIT_HMAC_KEY` / `SERVICE_API_KEY` 必须设置，否则 `:?` 报错阻断启动。
- 含 `BidPlatform.spec` / `BidPlatform.iss`：PyInstaller + InnoSetup 桌面端打包配置（说明 3.1 仍保留桌面分发路线）。

⚠️ **概念澄清（重要）**：3.1 的「三个服务」= **业务功能切分**（报价/文档/出件）；我们的「三服务器」= **算力与隐私切分**（应用 CPU / 解析 1×4090 / LLM 2×4090）。两者正交。我们**不需要**照搬它的微服务拆分——我们的编排由 DSH Agent 承担，算力分配由物理机承担。

### 9.2 模块清单演进（对比 2.0 新增了什么）

`app/modules/` 在 2.0 基础上显著细化，新增了一整条「评分点匹配 → 资质预审 → 填空 → 企业资产中台」链路：

| 模块 | 文件 | 职责 | 对我们 |
|---|---|---|---|
| `rules/` | `inspector.py` `registry.py` `validator.py` | **确定性合规引擎（核心）** | 直接抄 → 确定性 Tool 底座 |
| `rules` 数据 | `data/rules/*.json` | 通用披露 + 河北 4 套口径 | 复制改造成水利/陕西/双盲口径 |
| `industries` 数据 | `data/industries/water.json` 等 9 个 | 行业知识包 | `water.json` 直接做 RAGFlow 种子 |
| `docx_engine/` | `renderer.py` `cleanser.py` | OOXML 直写 + 元数据清洗 | 直接抄 → Render Tool |
| `collusion/` | `simhash.py` | 围串标相似度 + 报价规律 | 补进审标 Agent |
| `evaluation/` | `engine.py` `pdf_report.py` | 内测评标 + 公平性检测 | 补进审标 Agent |
| `tender_detect/` | `engine.py` | **歧视性/倾向性条款检测**（FAIR.*） | 补进解析 Agent |
| `matcher/` | `response_matrix.py` `prequalification.py` `qualification.py` `similarity.py` `personnel_solver.py` | 评分点响应矩阵 / 资质预审 / 人员求解 | 评分点驱动链路样板 |
| `qualification/` | `engine.py` `requirement.py` `verify.py` | 资质核验 | 补进解析/审标 |
| `filler/` | `docx_filler.py` | 从事实表填空到 docx | 对应项目事实表单一事实源 |
| `knowledge/` | `store.py` `industry_detect.py` | 知识库存储 + 行业识别 | 对应 RAGFlow |
| `assets/` | `store.py` | 企业资产中台（资质/人员/业绩/信用） | 对应 AGP 企业库 |
| `bidhub_import/` | `adapter.py` | 外部资产导入适配 | 可选 |
| `generation/` | `orchestrator.py` `llm.py` | 生成编排 + LLM 适配（同 2.0 原则） | 参考 score_matrix 生成 |

> 关键洞察：3.1 把 2.0 里「可行性论证过但没落地」的环节（评分点匹配、资质预审、填空、企业资产中台、围串标、公平性检测）**全部补齐并工程化**，这恰好是我们方案里 §4.3 规划但尚未细化的一层。等于别人替我们把「评分点驱动 + 资质对齐 + 围串标自检」的坑踩完了。

### 9.3 六个最该借鉴的点（带文件 + 映射）

#### ① 确定性合规引擎（rules 三件套 + 规则 JSON）—— 最该抄

这是整个 3.1 里**对我们价值最高、且零 LLM 依赖**的部分，可直接做我们「确定性 Tool 层」的底座：

- **`modules/rules/inspector.py`（docx→facts）**：纯确定性解析，**完全不调 LLM**，可复现可举证。处理 OOXML 单位换算（缇 twips / 半磅 / 行距 `w:line`+`w:lineRule` / 首行缩进 `firstLineChars`）；抓取：页边距、页眉页脚/水印、图片 EXIF 与色彩空间（gray/rgb 启发式）、修订（`w:ins`/`w:del`）、批注、隐藏文字（`w:vanish`）、rsid 会话标识、文档属性（creator/lastModifiedBy/company，且 company 同时查 core.xml 与 app.xml 两处）、段落字体/字号/颜色/行距/缩进/对齐/大纲级别。**标题识别用 `w:outlineLvl`，不依赖样式名**——避免模板差异误判。
- **`modules/rules/registry.py`（规则中心）**：模板加载 + **版本裁决**，把法律原则固化为代码：上位法优于下位法（`LEVEL_WEIGHT`：LAW 100 > ADMIN_REG 90 > … > STANDARD 50）、新法优于旧法（`supersedes` 自动标 ABOLISHED）、特别优于一般（scope 命中越具体分越高：市 +40 / 行业 +30 / 类型 +10）、招标文件约定优先（`or_follow_tender`）、草案不执行只预警（PENDING 仅进观察队列）。`match()` 按打分选主模板 + 叠加 `common-disclosure-v1` 通用模板，`effective_rules()` 合并去重（主模板优先）。
- **`modules/rules/validator.py`（判定引擎）**：`_DISPATCH` 表按 `detect` 类型分发（run.font.name / run.font.size / paragraph.line_spacing / doc.page.margins / text.pattern / metadata.* / marks.* / images.* 等 20+ 种）。每条 finding 含 `rule_id / severity / location / expected / actual / basis / suggestion / auto_fixable / needs_review`；`verdict`=REJECT/WARN/PASS；`score=100 - REJECT*15 - WARN*3`；**单条规则异常不中断整体**；标题段落自动跳过判定。
- **`data/rules/common_disclosure.json`（规则包 schema 范本）**：结构为 `template_id / name / region / scope{city,industry,tender_type} / legal_level / effective_from/to / status / supersedes / basis / source_url` + 每条 `rule{ id, category, type(HARD|SOFT), severity(REJECT|WARN|INFO), detect, expect, message, suggestion, basis, auto_fixable, needs_review }`。**17 条规则**覆盖 8 类身份泄露（统一社会信用代码/手机/邮箱/银行账号/单位名称【带 exclude 招标人/采购人/代理/监理/设计/发包】/地址/人员姓名/企业文化）+ 5 类元数据（creator/lastModifiedBy/company/revisions/comments/hidden_text/rsid/图片EXIF/图片色彩）。正则示例极具复用价值（如单位名称、人员「项目经理：张三」、企业文化「企业使命/核心价值观」）。

→ **映射**：我们的确定性 Tool 层**不必从零写**。拿这三件套做底座，复制 `hebei_provincial.json` 改写成「水利/陕西/双盲评审」口径包即可（只改 `region`/`scope`/`rules` 三处）。

#### ② 水利水电行业知识包 `water.json` —— 直接可用种子

`data/industries/water.json`（MIT）结构完整：
- **12 章节 outline**：每章含 `key_points`（必覆盖要点）、`writing_guide`（编写指引，如"水利工程概况要突出水文与地质两条主线"）、`common_traps`（常见扣分陷阱，如"导流标准选取无依据""无度汛安排"）。
- **6 工法 methods**：施工导流与围堰/大体积混凝土温控/防渗墙/帷幕灌浆/堤防填筑/河道清淤，各带 `key_controls` 与 `risk_level`（高/中）。
- **6 资质 qualifications**：水利水电工程施工总承包（特/一/二/三级）、安全生产许可证、注册建造师（水利水电）、水利安全考核 ABC 证、特种作业证、水利工程质量检测资质——含依据法规。
- **6 评分点 score_points**：施工导流与度汛（15-25分）、方案科学性（20-30分）、质量保证（10-15分）、安全生产与度汛安全（10-15分）、进度计划（10-15分）、环保水保（5-10分）——各带 `scoring_focus` 与 `lose_point_traps`。
- **9 法规 regulations**：SL 303-2017、SL 677-2014、SL 260-2014、DL/T 5129-2013、SL 223-2008、水利部令第26号、**水法/防洪法/水土保持法**（含 level 与 key_articles）。
- **6 风险 risks**（severity REJECT/WARN + mitigation）：度汛措施不落实（REJECT）、围堰/基坑坍塌（REJECT）、汛期安全事故（REJECT）、温控裂缝（WARN）等。
- **3 模板 templates**：导流度汛/大体积温控/堤防填筑要点（可直接改写复用）。

→ **映射**：这正是 P0 阶段要建的水利 RAGFlow 知识包种子。**投入最小、对标书质量提升最直接**——直接 JSON 入库或转 RAGFlow 文档，省去我们从零整理水利专业语料。

#### ③ OOXML 渲染器 `renderer.py` + `cleanser.py` —— 印证并细化我们的三分离

- **`docx_engine/renderer.py`**：严格践行「内容层/样式层/渲染层」三分离。不依赖 Word 样式名——**逐 run 写 `rPr`（rFonts 中/英/ASCII + sz/szCs 同步）/ 逐段写 `pPr`**；行距用 `w:spacing@w:line` + `w:lineRule="exact"`（固定值 30 磅→600）；缩进用 `w:ind@w:firstLineChars`（同时给缇值备份兼容旧阅读器）；标题层级用 `w:outlineLvl`（不靠样式名判定）；表格/项目符号/编号/引用 run 均显式直写。
- **关键细节坑**：写盘后**立即 `neutralize_metadata_inplace`** 清掉 python-docx 残留的 `creator="python-docx"` 等——否则会直接触发 `META.CREATOR` 否决项。文档明说「渲染完成后回读校验（inspector+validator），不合格最多 3 轮自修正」——**闭环自检**。
- **`cleanser.py`（15.8KB）**：`cleanse_docx()` 接受 `ai_label`（explicit/implicit/provider/model/contribution），把元数据/修订/批注/隐藏文字/rsid/图片 EXIF 全量清洗，并返回清洗后文档；回归测试 `test_compliance_regression.py::TestCleanse` 验证清洗后 5 类元数据规则必须 PASS。

→ **映射**：我们的 Render Tool 直接复用这套思路；`cleanser` 的 `neutralize` **必须一并搬**，否则自产 docx 会被自己的合规引擎判废标（讽刺但真实）。

#### ④ 围串标自检 `collusion/` + `evaluation/` —— 我们方案漏掉的新维度

- **`collusion/simhash.py`**：中文 bigram `tokenize` → `simhash` → `hamming_distance` → `similarity`（高度相似/较相似/差异明显）；用于**自查我方多份标书是否雷同**（雷同=围标嫌疑）。`evaluation/engine.py::detect_price_pattern` 检测报价**等差/等比规律**（围标常见特征）。
- 测试 `test_collusion.py` 给出完整断言：等差 `[2910万,2920万,2930万,2940万]`→等差规律；相似两文→高度相似；道路 vs 水库→差异明显。

→ **映射**：我们 §4.3 审标 Agent **此前未单列围串标自检**。水利行业审计严，应补进审标 Agent 作为合规加分项（输入：本项目历史标书 + 本次成稿 → 输出雷同度/报价规律风险）。

#### ⑤ 公平性/歧视性条款检测 `tender_detect/` + `benchmark/leaderboard.json` —— 读标阶段"踩雷"前置

- **`tender_detect/engine.py`** 输出 **FAIR.\*** 9 类：指定品牌/型号（`SPECIFY_BRAND`）、本地业绩加分（`REGION_PERFORMANCE`）、本地分支/纳税/注册（`LOCAL_BRANCH`）、限国有/排斥民营（`OWNERSHIP_RESTRICT`）、特定奖项加分（`SPECIFIC_AWARD`）、资质与规模不匹配（`QUALIFICATION_MISMATCH`）、排斥外地（`DISCRIMINATE_OUTSIDER`）、倾向性表述（`SENSITIVE_WORD`）、指定交易工具（`RESTRICT_TRADE_TOOL`）。
- **`benchmark/leaderboard.json`**：20 case（15 正例 + 5 负例），**F1=1.0**，自带评测集（含 expected/hit/correct 逐例）——可直接当我们的「读标拆解」回归测试。

→ **映射**：解析 Agent 的 `ConstraintSet` 应**额外产出"公平性风险条款清单"**，正好补 §4.3「读标→拆解」的歧视性条款识别（文章 11 七步法也强调"资格/否决条款"）。leaderboard 直接移植为我们的回归测试基线。

#### ⑥ 评分响应矩阵生成 `generate_from_score_matrix` —— 打通"评分点驱动大纲"

`generation/orchestrator.py::generate_from_score_matrix()`：把评分矩阵（每项 `score_item/score/criteria/response_suggestion/enterprise_assets`）**每个评分点→一个小节**，以响应建议 + 评分标准 + 企业素材组装指令，**1:1 响应**，确保不漏项、不跑题，最终拼成可渲染整册内容。配合 `matcher/response_matrix.py` 与 `filler/docx_filler.py`，形成「评分点 → 响应 → 填空 → docx」完整链路。

→ **映射**：这正是 §4.3 Planner + 文章 3「评分点驱动」的**工程实现样板**。我们的生成编排可照搬 `score_matrix` 数据结构与生成链路，把"说几页写几页、评分专家对号入座"落到代码。

### 9.4 与我们三服务器部署的差异对照

| 维度 | AIBidForge3.1 | 我们的三服务器方案 | 处置 |
|---|---|---|---|
| 部署单元 | compose 多 profile：主平台 + 3 业务微服务 + 可选 PG | 3 物理机分角色（应用 CPU / 解析 1×4090 / LLM 2×4090），DSH Agent 编排 | **不抄微服务拆分**，只抄其引擎/规则/知识资产 |
| 切分依据 | 业务功能（报价/文档/出件） | 算力与隐私（CPU/推理卡/超大模型） | 概念正交，勿混淆 |
| 模型 API | 可选 OpenAI 兼容，默认关闭（仅元数据级）；确定性引擎离线可跑 | Qwen3.8-27B 主力在线生成；`trust_env=False` 绕过 7897 代理 | 沿用我们方案，3.1 的 `trust_env=False` 再次印证正确 |
| 合规判定 | 确定性 rules 引擎（同原则） | 确定性 Tool 层（同原则，落地形态不同） | **直接复用其代码**，不重新发明 |
| 知识库 | 内置 `data/industries` + `data/rules` JSON + knowledge 模块 | RAGFlow 0.27.1 + AGP（检索更强，但缺 rules 引擎） | 用 RAGFlow 存知识、`water.json` 做种子；rules 引擎独立为 Tool |
| 多租户/权限 | 已含账号/权限/种子/PG 多租户 | 与研发隔离、私有化，权限走灵知工作台 | 不抄，按灵知既有体系 |
| 测试体系 | 全量回归（compliance/collusion/parser/tender_detect/fusion/pipeline/integration/auth/cross_service，11 个测试文件） | 尚未建回归测试 | **应补**，抄其 `test_compliance_regression.py` 范式 |
| 桌面端 | 保留 PyInstaller+InnoSetup 打包 | 走灵知 Web 工作台 | 不抄 |

### 9.5 精准复用清单（文件级，复制到我们工程的 DSH plugin / Python Tool）

| 用途 | 直接复用文件 | 落位 |
|---|---|---|
| 合规判定底座 | `app/modules/rules/inspector.py` `registry.py` `validator.py` | 确定性 Tool（Python，DSH plugin 调用） |
| 规则包范本 | `app/data/rules/common_disclosure.json` + `hebei_provincial.json` 等 4 套 | 复制改 `region/scope/rules` → 水利/陕西/双盲口径 |
| 水利知识种子 | `app/data/industries/water.json` | RAGFlow 知识包种子（P0） |
| 渲染与清洗 | `app/modules/docx_engine/renderer.py` `cleanser.py` | Render Tool + 元数据 neutralizer |
| 围串标自检 | `app/modules/collusion/simhash.py` + `app/modules/evaluation/engine.py` | 审标 Agent 增强（P3） |
| 公平性检测 | `app/modules/tender_detect/engine.py` + `benchmark/leaderboard.json` | 解析 Agent 公平性检测 + 回归基线 |
| 评分点驱动 | `app/modules/generation/orchestrator.py::generate_from_score_matrix` + `app/modules/matcher/response_matrix.py` | 生成编排 Planner（P2） |
| 回归测试范式 | `tests/test_compliance_regression.py` `test_collusion.py` `test_tender_parser.py` | 我们的合规回归测试模板 |
| LLM 适配 | `app/modules/generation/llm.py`（`trust_env=False` + SYSTEM_PROMPT 边界） | 调 Qwen3.8-27B 时沿用 |

### 9.6 对原方案 §4/§5 的修订建议

1. **§4.3 模块清单补两个 Tool**：⑦ 围串标自检 Tool（collusion）、⑧ 公平性条款检测 Tool（tender_detect）。并把"评分点响应矩阵生成"从 Planner 单独提成一步（对应 9.3⑥）。
2. **P2 与 P3 之间插入 P2.5 规则引擎与规则包落地**：先把 inspector/registry/validator + 规则 JSON 接进 DSH Tool（Python），**先于**生成编排——因为生成编排依赖它做合规校验与脱敏（否则生成即废标）。
3. **新增"回归测试"作为 P5 前的质量门禁**：对齐 3.1 的 `test_compliance_regression.py` 思路——锁定规则引擎检测能力，防止后续 LLM/模板改动引入回归。我们的规则包（`water.json` 衍生 + 公平性 FAIR.*）每次改动都跑一遍回归。
4. **P0 优先级微调**：`water.json` 入库优先级提到最高（投入最小、收益最直接），与 RAGFlow 知识库建设同步。

### 9.7 建议落地优先级（承接 §8 第 2、3 条）

| 序 | 动作 | 对应 Phase | 直接来源 |
|---|---|---|---|
| 1 | 迁 `water.json` → RAGFlow 水利知识包 | P0 | `data/industries/water.json` |
| 2 | 接 rules 三件套 + 规则 JSON → 确定性合规 Tool | P2.5（新增） | `modules/rules/*` + `data/rules/*` |
| 3 | 接 renderer/cleanser → Render Tool（含 neutralize） | P4 | `modules/docx_engine/*` |
| 4 | 接 collusion + tender_detect + leaderboard → 审标/解析增强 | P3 | `modules/collusion` `tender_detect` `benchmark` |
| 5 | 补回归测试门禁 | P5 前 | `tests/test_compliance_regression.py` 等 |
| 6 | 按 §7 列表充实 `bid-tools-plugin` 的 Tool 规则（先 parser 正则 + 脱敏 + FactCheck） | 持续 | 原 §7 + 本文 |

> 至此，13 篇文章分析 + 4 个开源仓库（AIBidForge2.0 / 3.1、易标 AI、docassemble）代码分析已全部完成，方案可直接进入 P0 实施。后续如需把本文件整理为 `.docx` 或拆成 DSH 任务卡，告知即可。
