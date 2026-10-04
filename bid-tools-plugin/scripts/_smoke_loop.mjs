process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const B = 'https://labragf.openagp.top:9080';
const K = 'ragflow-RzEu3ELCa9CXFNVK81-leL2m-KSM8XYmMJFM98m664w';
const LLM = 'https://llm.openagp.top:9080/v1';
const MODEL = 'Qwen3.8-27B-Q4_K_M.gguf';
const DS = 'be3bf3a2bf8a11f1af70f70707055cae,be561868bf8a11f1af70f70707055cae,be530c2cbf8a11f1af70f70707055cae,be4280aabf8a11f1af70f70707055cae,be5e66a8bf8a11f1af70f70707055cae,be4c5738bf8a11f1af70f70707055cae,be743a1ebf8a11f1af70f70707055cae,be664954bf8a11f1af70f70707055cae,8cdf8e80bf8b11f1af70f70707055cae'.split(',');

const q1 = '水利水电工程施工导流度汛方案的核心要点';
const q2 = '用一句话说明施工导流度汛方案的核心要点';

const t0 = Date.now();
const [rag, llm] = await Promise.all([
  fetch(`${B}/api/v1/retrieval`, {
    method: 'POST', headers: { Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataset_ids: DS, question: q1, top_k: 5, page: 1, page_size: 5, similarity_threshold: 0.2, vector_similarity_weight: 0.3 }),
  }).then(r => r.json()),
  fetch(`${LLM}/chat/completions`, {
    method: 'POST', headers: { Authorization: 'Bearer EMPTY', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: q2 }], max_tokens: 200, temperature: 0.2 }),
  }).then(r => r.json()),
]);

console.log('=== RAGFlow 检索 9 库 ===');
console.log('question:', q1);
const chunks = (rag.data && rag.data.chunks) || [];
console.log(`命中 ${chunks.length} 块（${Date.now() - t0}ms）`);
for (const c of chunks) {
  const txt = (c.content || '').replace(/\s+/g, ' ').slice(0, 100);
  console.log(`  - [${c.document_name || c.doc_name || '?'}] sim=${c.similarity?.toFixed(3)} ${txt}`);
}

console.log('\n=== LLM chat ===');
console.log('question:', q2);
const ans = llm.choices?.[0]?.message?.content || JSON.stringify(llm).slice(0, 300);
console.log('answer:', ans.slice(0, 300));
console.log(`(${Date.now() - t0}ms)`);