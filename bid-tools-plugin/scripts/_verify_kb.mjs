const B = 'https://labragf.openagp.top:9080';
const K = 'ragflow-RzEu3ELCa9CXFNVK81-leL2m-KSM8XYmMJFM98m664w';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const res = await fetch(`${B}/api/v1/datasets?page_size=50`, { headers: { Authorization: `Bearer ${K}` } });
const j = await res.json();
const list = (j.data || []).filter(d => d.name.startsWith('标书知识库'));
let tc = 0, td = 0;
for (const d of list) { tc += d.chunk_count; td += d.document_count; console.log(`${d.name.replace('标书知识库·','')}: id=${d.id} docs=${d.document_count} chunks=${d.chunk_count}`); }
console.log(`TOTAL: ${list.length} datasets, ${td} docs, ${tc} chunks`);