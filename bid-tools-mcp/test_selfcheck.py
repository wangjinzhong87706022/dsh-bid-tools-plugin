# -*- coding: utf-8 -*-
"""bid-tools 功能自测（不依赖真实 LLM/RAGFlow，外部调用全部打桩）。"""
import asyncio
import json
import sys


import server  # noqa: E402
from schemas import ComplianceItem, requirements_from_llm_json  # noqa: E402
from llm_client import LLMClient  # noqa: E402

PASS = 0
FAIL = 0

def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"OK   {name}")
    else:
        FAIL += 1
        print(f"FAIL {name} {detail}")


async def main():
    # 1. MCP 工具注册
    tools = await server.mcp.list_tools()
    names = {t.name for t in tools}
    expect = {"tender_extract_requirements", "kb_search_materials", "bid_check_compliance", "bid_archive_final"}
    check("4 个工具全部注册", expect <= names, f"实际: {names}")

    # 2. 分块：10000 字文本按 6000 切分，块间有重叠
    text = ("甲乙丙丁测试段落。\n\n" * 1200)[:12000]
    chunks = server._split_chunks(text)
    check("分块产生多块", len(chunks) >= 2, f"块数={len(chunks)}")
    check("分块无内容丢失(首块非空)", all(c.strip() for c in chunks))

    # 3. 证据定位
    draft = "本项目计划工期为 180 个日历天，质保期两年。" + "填充" * 200
    ev = server._find_evidence(draft, ["工期", "质保期"])
    check("关键词证据定位命中", "180" in ev or "质保" in ev, f"ev={ev[:50]}")

    # 4. LLM 输出 JSON 容错提取（带 ```json 包裹 + 前后杂文字）
    raw = '好的，以下是结果：\n```json\n{"tender_name":"测试","items":[{"id":"R1","category":"评分点","content":"技术方案完备性占30分","keywords":["技术方案"]}]}\n```\n如需调整请告知。'
    parsed = LLMClient._extract_json(raw)
    check("JSON 容错提取成功", parsed is not None and parsed.get("tender_name") == "测试")

    # 5. 脏数据 -> RequirementList（错误类别降级、空壳过滤）
    dirty = {"tender_name": "X", "items": [
        {"category": "离谱类别", "content": "投标单位须具备水利工程施工总承包一级资质"},
        {"category": "废标条款", "content": "ab"},          # 太短应被过滤
        {"category": "商务条款", "content": "工期不超过180日历天", "keywords": ["工期", "180"]},
        "不是字典的脏数据",                                  # 应被跳过
    ]}
    rl = requirements_from_llm_json(dirty)
    check("脏数据过滤与降级", len(rl.items) == 2 and rl.items[0].category == "商务条款" and rl.items[1].id == "R002",
          f"items={[(i.id, i.category) for i in rl.items]}")

    # 6. 合规自查全链路（LLM 打桩：语义复核一律返回"偏离"）
    async def fake_semantic(req, draft):
        return ComplianceItem(requirement_id=req.id, requirement_content=req.content,
                              status="偏离", evidence="", comment="打桩结论")

    orig = server._llm_semantic_check
    server._llm_semantic_check = fake_semantic
    reqs = rl.model_dump_json()
    result = await server.bid_check_compliance.fn(reqs, draft) if hasattr(server.bid_check_compliance, "fn") \
        else await server.bid_check_compliance(reqs, draft)
    server._llm_semantic_check = orig
    rep = json.loads(result)
    check("合规报告结构完整", {"total", "fully_met", "deviated", "missing", "items"} <= set(rep))
    check("统计数一致", rep["total"] == rep["fully_met"] + rep["deviated"] + rep["missing"])
    check("命中关键词判定为完全响应", rep["fully_met"] == 1, json.dumps(rep, ensure_ascii=False)[:200])
    check("未命中走LLM复核为偏离", rep["deviated"] == 1)

    # 7. 归档工具的参数校验（未配置 dataset_id 时报错而非崩溃）
    r = await (server.bid_archive_final.fn if hasattr(server.bid_archive_final, "fn") else server.bid_archive_final)(
        file_path="/data/x.docx", project="测试")
    check("未配置归档库时优雅报错", '"error"' in r, r)

    print(f"\n===== 自测结果: PASS={PASS} FAIL={FAIL} =====")
    return FAIL


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
