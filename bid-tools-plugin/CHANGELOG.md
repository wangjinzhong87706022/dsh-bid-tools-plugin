# Changelog

本文件记录 bid-tools-plugin 的版本变更。日期为提交日，非发布日。

## [0.2.0] — 2026-10-04

### 新增

- **ProjectFacts 单一事实源**（3 工具）：`project_facts_init` / `project_facts_update` / `project_facts_check`
  - 从需求抽取结果自动提取 12 类事实（项目名/工期/预算/资质/评分权重/关键参数/风险条款/格式条款/评分条款/所需文档/人员要求）
  - 增量更新带版本号 + 一致性校验报告
  - 文档内容与事实表一致性校验（工期/预算/资质匹配）
- **OOXML 渲染导出**（1 工具）：`bid_render_docx`
  - Markdown → .docx，jszip 直写 OOXML，无需 Word 安装
  - 支持标题/段落/列表/表格/加粗/斜体/页眉页脚/元数据
- **端到端七步流程测试**：`tests/e2e-real.cjs`，真实 LLM + RAGFlow 环境下 16 工具全链路回放
- **9 行业知识库灌库**：461 chunks，覆盖施工/EPC/材料设备/MEP/市政/新能源/交通/城市更新/水利

### 变更

- 工具数量 12 → 16（3 ProjectFacts + 1 render）
- `src/index.ts`：注册 16 工具
- `package.json`：`main` → `./lib/index.js`，新增 `build` 脚本，`test:smoke` 用 `--rewriteRelativeImportExtensions`
- `tsconfig.json`：新增 `allowImportingTsExtensions`
- `cordis.patch.yml`：改为正确 `- insert` 格式
- 所有 `src/*.ts`：相对 import 加 `.ts` 扩展名（Node 24 ESM 要求）
- `src/vendor.d.ts`：补充 jszip 类型（file 写入 + generateAsync）
- `.gitignore`：新增 `lib/`、`.smoke-out/`、`.env`

### 修复

- 代码评审 A1-A4：PII 正则顺序（银行账号被信用代码吃掉）、vendor.d.ts Python 风格头、规则引擎口径配置、docx 页数估算边界
- 代码评审 B1/B2/B4/B5/B6/B7/B9/B10：类型安全、错误处理、边界条件等次要问题
- DSH 真实 API 适配：12 工具加 `output`/`render`/`jsonRender`/`toJson`

### 验证

- `npx tsc --noEmit` ✅
- `npm run build` ✅
- `npm run test:smoke` 26/26 ✅
- DSH headless 挂载：16 工具注册成功 ✅
- DSH web 挂载：0 错误启动，UI 可访问 ✅
- 端到端七步流程（真实 LLM + RAGFlow）✅

## [0.1.0] — 2026-09-30

### 初始实现

- 12 工具：`tender_extract_requirements` / `tender_parse_constraints` / `kb_search_materials` / `bid_check_compliance` / `bid_check_rules` / `bid_audit_docx` / `bid_scan_disclosure` / `bid_mask_pii` / `bid_fact_check` / `bid_check_collusion` / `bid_check_fairness` / `bid_archive_final`
- 确定性规则引擎：REJECT/WARN/PASS 判定，可复现可举证
- 9 行业知识包 + 河北地域暗标模板（来自 AIBidForge3.1，MIT）
- FAIR.* 9 类公平竞争审查
- SimHash 围串标检测 + 报价规律识别
- OOXML docx 全量审计（几何/元数据/痕迹/图片）