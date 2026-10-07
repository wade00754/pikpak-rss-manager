// Run from the repository root with make test-ui.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const document={documentElement:{},createTreeWalker:()=>({nextNode:()=>false}),querySelectorAll:()=>[]};
const ctx=vm.createContext({document,NodeFilter:{SHOW_TEXT:4},localStorage:{getItem:()=> 'en'}});
vm.runInContext(fs.readFileSync('internal/web/static/i18n.js','utf8'),ctx);
const evaluate=code=>vm.runInContext(code,ctx);
assert.equal(evaluate("t('新增任務')"),'Add task');
assert.equal(evaluate("t('密碼')"),'Password');
assert.equal(evaluate("t('請輸入密碼')"),'Enter a password.');
assert.equal(evaluate("t('檢查完成：新增 2 筆、去重 3 筆')"),'Check complete: 2 added, 3 duplicates');
assert.equal(evaluate("tr`<h3>目標：${'新增任務/作品.mkv'}</h3>`"),'<h3>Destination: 新增任務/作品.mkv</h3>');
assert.equal(evaluate("JSON.stringify(localizeResponse({error:'密碼不正確',name:'總覽',filename:'新增任務.mkv',rule:{title:'系統設定',regex:'第[0-9]+'},notices:['部分種子無法取得或解析檔名，可重新讀取。']}))"),JSON.stringify({error:'Incorrect password.',name:'總覽',filename:'新增任務.mkv',rule:{title:'系統設定',regex:'第[0-9]+'},notices:['Some torrent filenames could not be read. Try again.']}));
for(const match of ['app.js','backfill.js','theme.js'].map(name=>fs.readFileSync('internal/web/static/'+name,'utf8')).join('\n').matchAll(/\bt\(('(?:\\.|[^'\\])*')\)/g)){
 const text=evaluate(match[1]);
 assert.ok(!/[\u3400-\u9fff]/.test(evaluate('t('+JSON.stringify(text)+')')),'Missing runtime translation: '+text);
}
for(const name of ['app','setup','login','onboarding']){
 const page=fs.readFileSync('internal/web/templates/'+name+'.html','utf8');
 // Check application-owned static text and accessibility attributes for coverage.
 const copy=[...page.matchAll(/>([^<>]+)</g)].map(m=>m[1]);
 copy.push(...[...page.matchAll(/(?:placeholder|aria-label|title)="([^"]+)"/g)].map(m=>m[1]));
 for(const text of copy){
   if(!/[\u3400-\u9fff]/.test(text)||text==='繁體中文')continue;
   assert.ok(!/[\u3400-\u9fff]/.test(evaluate('translateLiteral('+JSON.stringify(text)+')')),'Missing translation: '+text);
 }
}
evaluate("language='zh-Hant'");
assert.equal(evaluate("t('新增任務')"),'新增任務');
assert.equal(evaluate("tr`目標：${'Series.mkv'}`"),'目標：Series.mkv');
for(const current of ['zh-Hant','en']){
 const attrs={},handlers={},saved=[];
 let reloads=0;
 const button={setAttribute:(key,value)=>{attrs[key]=value;},addEventListener:(event,handler)=>{handlers[event]=handler;}};
 const toggleContext=vm.createContext({
  document:{documentElement:{},createTreeWalker:()=>({nextNode:()=>false}),querySelectorAll:selector=>selector==='.language-toggle'?[button]:[]},
  NodeFilter:{SHOW_TEXT:4},localStorage:{getItem:()=>current,setItem:(...entry)=>saved.push(entry)},location:{reload:()=>{reloads++;}}
 });
 vm.runInContext(fs.readFileSync('internal/web/static/i18n.js','utf8'),toggleContext);
 assert.equal(button.textContent,current==='en'?'繁體中文':'English');
 assert.equal(button.lang,current==='en'?'zh-Hant':'en');
 assert.equal(attrs['aria-label'],current==='en'?'Switch to Traditional Chinese':'切換為英文');
 handlers.click();
 assert.deepEqual(saved,[['language',current==='en'?'zh-Hant':'en']]);
 assert.equal(reloads,1);
}
console.log('Localization checks passed.');
