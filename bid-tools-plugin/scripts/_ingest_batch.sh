#!/bin/bash
cd /e/git/dsh-bid-tools-plugin/bid-tools-plugin
export NODE_TLS_REJECT_UNAUTHORIZED=0
export RAGFLOW_BASE_URL=https://labragf.openagp.top:9080
export RAGFLOW_API_KEY=ragflow-RzEu3ELCa9CXFNVK81-leL2m-KSM8XYmMJFM98m664w
export RAGFLOW_EMBEDDING_MODEL="bge-m3@xinference-emb@OpenAI-API-Compatible"

for pack in construction epc material_equipment mep municipal new_energy transport urban_renewal; do
  node scripts/ingest-industries.mjs --pack "$pack" > "/tmp/ingest_${pack}.log" 2>&1 &
done
wait
echo "=== ALL INGEST DONE ==="
grep -h "全部完成" /tmp/ingest_*.log