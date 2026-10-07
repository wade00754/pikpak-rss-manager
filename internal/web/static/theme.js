'use strict';
const themeMedia=window.matchMedia('(prefers-color-scheme: dark)');
let themePreference;
try{themePreference=localStorage.getItem('theme');}catch{}
function applyTheme(){
  const dark=themePreference==='dark'||(themePreference!=='light'&&themeMedia.matches);
  document.documentElement.dataset.theme=dark?'dark':'light';
  for(const button of document.querySelectorAll('.theme-toggle')){
    const label=dark?t('切換淺色模式'):t('切換深色模式');
    button.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(dark?'<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>':'<path d="M20.5 13a8.5 8.5 0 0 1-9.5-9.5A8.5 8.5 0 1 0 20.5 13z"/>')+'</svg>';button.title=label;button.setAttribute('aria-label',label);button.setAttribute('aria-pressed',String(dark));
  }
}
// This script runs before styles load to apply the saved/system preference
// without flashing a light page. Controls are localized after DOM initialization.
applyTheme();
document.addEventListener('DOMContentLoaded',applyTheme);
document.addEventListener('click',event=>{
  if(!event.target.closest('.theme-toggle'))return;
  themePreference=document.documentElement.dataset.theme==='dark'?'light':'dark';
  try{localStorage.setItem('theme',themePreference);}catch{}
  applyTheme();
});
themeMedia.addEventListener('change',applyTheme);
window.addEventListener('storage',event=>{if(event.key==='theme'||event.key===null){themePreference=event.newValue;applyTheme();}});
