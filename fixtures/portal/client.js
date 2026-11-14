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

let revision, pendingSave, inFlight = Promise.resolve(), stopped = false;
async function load() {
  const data = await api('/api/document');
  revision = data.revision;
  stopped = false;
  query('#revision').textContent = `修订 ${revision}`;
  query('#editor').innerHTML = data.html;
  notice('草稿已读取');
}
document.querySelectorAll('[data-command]').forEach(button => {
  button.onmousedown = event => event.preventDefault();
  button.onclick = () => { query('#editor').focus(); document.execCommand(button.dataset.command); };
});
document.querySelectorAll('[data-block]').forEach(button => {
  button.onmousedown = event => event.preventDefault();
  button.onclick = () => {
    query('#editor').focus();
    document.execCommand('formatBlock', false, button.dataset.block);
  };
});
query('#link').onmousedown = event => event.preventDefault();
query('#link').onclick = () => {
  query('#editor').focus();
  const target = prompt('链接目标');
  if (target) document.execCommand('createLink', false, target);
};
query('#editor').addEventListener('paste', event => {
  event.preventDefault();
  const text = event.clipboardData.getData('text/plain');
  document.execCommand('insertText', false, text);
});

function performSave() {
  if (stopped) {
    notice('草稿修订冲突：请重新读取并人工处理，保存已停止');
    return Promise.reject(new Error('草稿修订冲突'));
  }
  return api('/api/document', { revision, html: query('#editor').innerHTML }).then(data => {
    revision = data.revision;
    query('#revision').textContent = `修订 ${revision}`;
    notice('草稿已保存');
    return data;
  }, error => {
    if (String(error.message).includes('冲突')) stopped = true;
    notice(error.message);
    throw error;
  });
}
function save() {
  clearTimeout(pendingSave);
  const run = inFlight.then(performSave, performSave);
  inFlight = run.catch(() => {});
  return run;
}
query('#editor').addEventListener('input', () => {
  clearTimeout(pendingSave);
  pendingSave = setTimeout(() => save().catch(() => {}), 500);
});
query('#save').onclick = () => save().catch(error => notice(error.message));
query('#reload').onclick = () => load().catch(error => notice(error.message));
await load();
