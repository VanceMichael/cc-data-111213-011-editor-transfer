const query = selector => document.querySelector(selector);
async function api(path, value) {
  const response = await fetch(path, value === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || data.status || '操作未接纳');
  return data;
}
function notice(value) { query('#notice').textContent = typeof value === 'string' ? value : JSON.stringify(value); }
window.addEventListener('unhandledrejection', event => { event.preventDefault(); notice(event.reason.message); });

let revision, pendingSave;
async function load() { const data=await api('/api/document'); revision=data.revision; query('#revision').textContent=`修订 ${revision}`; query('#editor').innerHTML=data.html; }
document.querySelectorAll('[data-command]').forEach(button => {
  button.onmousedown=event=>event.preventDefault();
  button.onclick=()=>{ query('#editor').focus(); document.execCommand(button.dataset.command); };
});
query('#link').onmousedown=event=>event.preventDefault();
query('#link').onclick=()=>{ const target=prompt('链接目标'); if(target)document.execCommand('createLink',false,target); };
query('#editor').addEventListener('paste',event=>{
  event.preventDefault(); const text=event.clipboardData.getData('text/plain'); document.execCommand('insertText',false,text);
});
async function save(){clearTimeout(pendingSave);const data=await api('/api/document',{ revision,html:query('#editor').innerHTML });revision=data.revision;query('#revision').textContent=`修订 ${revision}`;notice('草稿已保存');}
query('#editor').addEventListener('input',()=>{clearTimeout(pendingSave);pendingSave=setTimeout(()=>save().catch(error=>notice(error.message)),500);});
query('#save').onclick=save;
query('#reload').onclick=load;
await load(); notice('草稿已读取');
