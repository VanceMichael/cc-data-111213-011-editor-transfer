import {writeFile,mkdir} from 'node:fs/promises';
await mkdir('fixtures',{recursive:true});
await writeFile('fixtures/state.json',JSON.stringify({"document": {"revision": 1, "html": "<p>安装前请断电。</p>", "published": false}, "saveDelay": 0},null,2));
await writeFile('fixtures/portal.json',JSON.stringify({"title": "富文本门户的语义化录入与回读", "local": true, "roles": ["人工使用者"], "entry": "/", "scenario": "editor-transfer"},null,2));
await writeFile('fixtures/certificate.txt','合成检测证明：SYN-001\n');
// fixtures/source/ 是已提交的结构化来源文档，由维护者直接编辑，不在此重建。
