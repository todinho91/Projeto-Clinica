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
    assert.equal(core.localDate('2026-11-26 14:35:00'),'26/11/2026 às 14:35');
    assert.equal(core.localDate('valor inválido'),'—');
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
    assert.match(html,/css\/dashboard\.css/);
    for(const id of ['clinic-name','profissional','especialidade','data-atendimento','contexto-clinica','abrir-menu','fechar-menu'])assert.match(html,new RegExp(`id="${id}"`));
});

test('conflito preserva texto local e exige revisão explícita antes de retomar',()=>{
    const js=readFileSync(path.join(base,'js/prontuario-experimental.js'),'utf8');
    const html=readFileSync(path.join(base,'prontuario-experimental.html'),'utf8');
    assert.match(js,/if\(e\.status===409\)\{conflict\(\);\}/);
    assert.match(js,/conflictLatest=latest\.registro/);
    assert.match(js,/record=\{\.\.\.record,\.\.\.conflictLatest\}/);
    assert.match(html,/id="revisar-conflito"/);
    assert.match(html,/id="descartar-local"/);
});
test('mascara a tela, revalida no retorno e limita espera de rede',()=>{
    const js=readFileSync(path.join(base,'js/prontuario-experimental.js'),'utf8');
    assert.match(js,/masked=true;page\.hidden=true/);
    assert.match(js,/if\(doc\.hidden\)mask\(\);else verify\(\)/);
    assert.match(js,/setInterval\(verify,5000\)/);
    assert.match(js,/AbortSignal\.timeout\(8000\)/);
    assert.match(js,/win\.top!==win\.self/);
});

test('identidade visual e navegação clínica respeitam a capacidade autorizada',()=>{
    const html=readFileSync(path.join(base,'prontuario-experimental.html'),'utf8');
    const js=readFileSync(path.join(base,'js/prontuario-experimental.js'),'utf8');
    assert.match(html,/class="vitalis-brand-mark"[^>]*><svg/);
    assert.match(html,/id="clinical-nav" data-ready="false"/);
    assert.ok(js.indexOf("el('clinical-nav').dataset.ready='true'")>js.indexOf("if(capability.experimental!==true)"));
    assert.ok(js.includes("el('clinical-nav').dataset.ready='false'"));
    assert.match(js,/function renderNavigation\(doc,core,clinic/);
    assert.match(js,/core\.workspaceNavigation\(clinic\)/);
    assert.match(js,/roleCanAccessPage\('profissional','prontuario-experimental\.html'/);
    assert.match(js,/navigation\.replaceChildren\(fragment\)/);
    assert.doesNotMatch(js,/link\.innerHTML/);
});
test('histórico recolhido e leitura final preservam distinção entre registro e adendos',()=>{
    const html=readFileSync(path.join(base,'prontuario-experimental.html'),'utf8');
    const js=readFileSync(path.join(base,'js/prontuario-experimental.js'),'utf8');
    assert.match(html,/<details id="historico-alteracoes"[^>]*hidden/);
    assert.match(html,/id="registro-finalizado-bloco"[^>]*hidden/);
    assert.match(html,/id="complementacoes-bloco"[^>]*hidden/);
    assert.match(html,/<summary>Histórico de alterações<\/summary>/);
    assert.match(js,/versao_finalizada/);
    assert.match(js,/fieldLabels\[key\]/);
    assert.match(js,/Mais histórico e complementações/);
    assert.doesNotMatch(js,/win\.confirm\(/);
});
test('finalização mostra validação junto aos campos e oferece modal acessível',()=>{
    const html=readFileSync(path.join(base,'prontuario-experimental.html'),'utf8');
    const js=readFileSync(path.join(base,'js/prontuario-experimental.js'),'utf8');
    const client=readFileSync(path.join(base,'js/vitalis-client.js'),'utf8');
    assert.match(client,/createElement\('dialog'\)/);
    assert.match(client,/aria-describedby/);assert.match(client,/showModal\(\)/);
    assert.match(client,/event\.preventDefault\(\); finish\(false\)/);
    assert.match(html,/id="finalization-errors"[^>]*role="alert"/);
    assert.match(html,/id="erro-evolucao"/);assert.match(html,/id="erro-conduta"/);assert.match(html,/id="erro-identificacao"/);
    assert.match(js,/e\.code==='RECORD_INCOMPLETE'/);
    assert.match(js,/VitalisConfirm\.ask/);
});
test('acesso direto da secretaria volta ao painel administrativo sem abrir a área clínica',()=>{
    const js=readFileSync(path.join(base,'js/prontuario-experimental.js'),'utf8');
    const admin=readFileSync(path.join(base,'dashboard-secretaria.html'),'utf8');
    const main=readFileSync(path.join(base,'js/main.js'),'utf8');
    assert.match(js,/session\.activeClinic\?\.papel==='secretaria'/);
    assert.match(js,/page\.hidden=true/);
    assert.match(js,/aviso=acesso-clinico-restrito/);
    assert.match(admin,/id="access-notice"[^>]*role="status"/);
    assert.match(main,/O prontuário é restrito ao profissional responsável/);
});
test('confirmações compartilhadas não usam diálogos nativos do navegador',()=>{
    const main=readFileSync(path.join(base,'js/main.js'),'utf8');
    const client=readFileSync(path.join(base,'js/vitalis-client.js'),'utf8');
    assert.doesNotMatch(main,/window\.confirm\s*\(/);
    assert.match(client,/window\.VitalisConfirm = window\.VitalisConfirm \|\|/);
    assert.match(client,/active\.then\(\(\) => confirmOnce\(message\)\)/);
    assert.match(client,/cancel\.focus\(\)/);
    assert.match(client,/dialog\.remove\(\)/);
});
