const assert=require('node:assert/strict');
const {test}=require('node:test');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const base=path.join(__dirname,'../../..');
const core=require(path.join(base,'js/prontuario-experimental.js'));
test('prontuário limita payload e elegibilidade',()=>{
    assert.equal(core.clinicalPayload({queixa:' teste ',autor_usuario_id:9}).queixa,'teste');
    assert.equal(core.clinicalPayload({}).alergias,null);
    assert.equal(Object.hasOwn(core.clinicalPayload({clinica_id:2}),'clinica_id'),false);
    assert.throws(()=>core.clinicalPayload({queixa:'é'.repeat(5000)}));
    assert.equal(core.eligible({status:'agendada',pode_concluir:false}),false);
    assert.equal(core.eligible({status:'realizada'}),true);
    assert.equal(core.loopback('example.test'),false);
});
test('troca de contexto invalida e aborta requisições antigas',()=>{
    const gate=core.contextGate(),old=gate.begin(),current=gate.begin();
    assert.equal(old.signal.aborted,true);assert.equal(gate.current(old),false);
    assert.equal(gate.current(current),true);gate.clear();assert.equal(gate.current(current),false);
});
test('interface sem armazenamento clínico persistente ou HTML dinâmico',()=>{
    const js=readFileSync(path.join(base,'js/prontuario-experimental.js'),'utf8');
    const html=readFileSync(path.join(base,'prontuario-experimental.html'),'utf8');
    assert.doesNotMatch(js,/innerHTML|insertAdjacentHTML|localStorage|sessionStorage\.setItem/);
    assert.match(js,/cache:'no-store'/);assert.match(js,/e\.status===409/);
    assert.match(html,/autocomplete="off"/);assert.match(html,/viewport/);
    assert.match(html,/Content-Security-Policy/);assert.doesNotMatch(html,/<script[^>]+src="https?:/);
});
