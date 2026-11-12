import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {startPortal} from '../src/portal.js';
test('本地门户现有人工操作可执行且保持业务边界',{timeout:25000},async()=>{
  const portal=await startPortal();
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  try{const page=await browser.newPage();await page.goto(portal.url);await page.waitForFunction(()=>document.querySelector('#notice').textContent.length>0);

await page.getByRole('textbox',{name:'说明正文'}).fill('先断电，再安装。');
await page.getByRole('button',{name:'保存草稿'}).click();
await page.waitForFunction(()=>document.querySelector('#notice').textContent==='草稿已保存');
assert.equal(portal.state.document.revision, 2);
await fetch(`${portal.url}/api/control`,{method:'POST',body:JSON.stringify({document:{revision:3,html:'<p>人工修订</p>',published:false}})});
await page.getByRole('button',{name:'保存草稿'}).click();
await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('冲突'));
assert.equal(portal.state.document.revision, 3);

  }finally{await browser.close();await portal.close();}
});
