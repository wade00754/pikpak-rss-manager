'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync('internal/web/static/app.js','utf8');
const handler=source.slice(source.indexOf('function bindTokenForm(){'),source.indexOf('async function start(){'));
(async()=>{
  for(const onboarding of [true,false]){
    let submit,fail=true,reloads=0,loads=0;
    const calls=[],notices=[];
    const form={dataset:{onboarding:String(onboarding)},addEventListener:(event,fn)=>{assert.equal(event,'submit');submit=fn;}};
    const button={disabled:false},token={value:'invalid-fixture'},error={textContent:''};
    const elements={'#token-form':form,'#save-token':button,'#token':token,'#token-error':error};
    const location={hash:'',reload:()=>{reloads++;}};
    const ctx=vm.createContext({$:key=>elements[key],location,t:value=>value,toast:value=>notices.push(value),load:async()=>{loads++;},
      api:async(...args)=>{calls.push(args);assert.equal(button.disabled,true);if(fail)throw Error('Fixture rejection');return {connected:true};}});
    vm.runInContext(handler+'\nbindTokenForm();',ctx);
    await submit({preventDefault(){}});
    assert.equal(error.textContent,'Fixture rejection');
    assert.equal(token.value,'');
    assert.equal(button.disabled,false);
    assert.equal(reloads,0);
    assert.equal(loads,0);
    fail=false;token.value='fixture-pat';
    await submit({preventDefault(){}});
    assert.equal(error.textContent,'');
    assert.equal(token.value,'');
    assert.equal(button.disabled,false);
    assert.deepEqual(calls.map(call=>call.slice(0,2)),[['/api/settings/pikpak','POST'],['/api/settings/pikpak','POST']]);
    assert.equal(reloads,onboarding?1:0);
    assert.equal(loads,onboarding?0:1);
    assert.equal(location.hash,onboarding?'overview':'');
    assert.equal(notices.length,onboarding?0:1);
  }
  console.log('Onboarding failure, retry, completion and settings refresh checks passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
