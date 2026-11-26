(function(root,factory){
    const core=factory();
    if(typeof module==='object'&&module.exports) module.exports=core;
    else root.addEventListener('DOMContentLoaded',()=>core.mount(root));
})(typeof globalThis!=='undefined'?globalThis:this,()=>{
    const fields=['queixa','anamnese','antecedentes','alergias','medicamentos','avaliacao','evolucao','diagnostico','conduta'];
    const loopback=host=>['127.0.0.1','localhost'].includes(host);
    const validId=value=>/^[1-9]\d*$/.test(String(value))&&Number.isSafeInteger(Number(value));
    function eligible(row){return row.status==='realizada'||(['agendada','confirmada'].includes(row.status)&&row.pode_concluir===true);}
    function clinicalPayload(values){
        const encoder=new TextEncoder(), output={};
        for(const field of fields){
            const value=String(values[field]??'').trim();
            if(encoder.encode(value).length>8000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw Error('Campo clínico inválido ou muito longo.');
            output[field]=value||null;
        }
        if(encoder.encode(JSON.stringify(output)).length>32000)throw Error('O registro excede o limite permitido.');
        return output;
    }
    function contextGate(){
        let sequence=0,controller;
        return {
            begin(){controller?.abort();controller=new AbortController();return {id:++sequence,signal:controller.signal};},
            clear(){sequence++;controller?.abort();},
            current(ticket){return ticket.id===sequence&&!ticket.signal.aborted;}
        };
    }
    function mount(win){
        const doc=win.document, el=id=>doc.getElementById(id), entry=el('prontuario-experimental-link');
        const page=el('workspace'); if(!page&&!entry)return;
        const session=win.VitalisCore.createSession(win.sessionStorage);
        const validContext=()=>loopback(win.location.hostname)&&['http:','https:'].includes(win.location.protocol)
            &&session.activeClinic?.papel==='profissional'&&session.clinicToken&&session.identityToken;
        const context=()=>JSON.stringify([session.activeClinic?.id,session.activeClinic?.papel,session.clinicToken,session.identityToken]);
        let initial=context();
        const gate=contextGate();
        const base='http://'+win.location.hostname+':3000/api';
        async function request(ticket,path,method='GET',body){
            if(!validContext()||context()!==initial||!gate.current(ticket))throw Error('Contexto alterado.');
            const headers={Authorization:'Bearer '+session.clinicToken};
            if(body!==undefined)headers['Content-Type']='application/json';
            const response=await win.fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:ticket.signal,cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
            if(!gate.current(ticket)||context()!==initial||!validContext())throw Error('Contexto alterado.');
            if(!response.ok){const error=Error('Operação não concluída.');error.status=response.status;throw error;}
            const result=await response.json();
            if(!gate.current(ticket)||context()!==initial)throw Error('Contexto alterado.');
            return result;
        }
        if(entry){
            if(validContext()){
                const ticket=gate.begin();
                request(ticket,'/prontuarios/capacidade').then(r=>{if(gate.current(ticket)&&r.experimental===true)entry.hidden=false;}).catch(()=>{entry.hidden=true;});
            }
            win.addEventListener('pagehide',()=>{gate.clear();entry.hidden=true;});
            return;
        }
        const status=msg=>{el('status').textContent=msg;};
        let appointments=[],selected=null,record=null,editable=false,dirty=false,busy=false,conflicted=false,versionPage=1,historyPage=1;
        function clearRecord(){
            record=null;editable=false;dirty=false;conflicted=false;versionPage=1;historyPage=1;
            for(const field of [...fields,'motivo','texto'])el(field).value='';
            for(const id of ['estado','paciente'])el(id).textContent='';
            for(const id of ['versoes','historico'])el(id).replaceChildren();
            for(const id of ['editor','adendo','criar','mais-versoes','mais-historico'])el(id).hidden=true;
        }
        function clearAll(message){
            gate.clear();clearRecord();selected=null;appointments=[];busy=false;
            el('consulta').replaceChildren(new win.Option('Selecione uma consulta',''));
            page.hidden=true;el('contexto').textContent='';el('recarregar').disabled=false;status(message);
        }
        function controls(){
            const draft=record?.estado==='rascunho'&&editable&&!conflicted;
            el('criar').hidden=Boolean(record)||!selected||!editable||conflicted;
            el('editor').hidden=!draft;
            el('adendo').hidden=record?.estado!=='finalizado'||!editable||conflicted;
            for(const id of ['criar','salvar','descartar','adicionar','mais-versoes','mais-historico','consulta','recarregar'])el(id).disabled=busy;
            el('finalizar').disabled=busy||dirty||!draft;
            for(const id of [...fields,'motivo','texto'])el(id).disabled=busy;
        }
        function error(ticket,e){
            if(!gate.current(ticket))return;
            if(e.status===401||e.status===403||e.status===404||e.status===503||e.status>=500||!e.status){
                clearAll(e.status===503?'Prontuário indisponível: ambiente sintético não habilitado.':'Acesso ou registro indisponível. Conteúdo removido da tela.');return;
            }
            if(e.status===409){conflicted=true;dirty=false;for(const field of [...fields,'motivo','texto'])el(field).value='';el('versoes').replaceChildren();status('Conflito de versão ou consulta. Atualize a agenda e reabra o atendimento; nada será reenviado automaticamente.');}
            else status(e.status===422?'Registro incompleto. Verifique evolução, conduta e identificação profissional.':'Dados inválidos. Revise os campos.');
        }
        function addText(parent,tag,text){const node=doc.createElement(tag);node.textContent=String(text??'');parent.append(node);return node;}
        async function versions(ticket,append=false){
            if(!record)return;
            const result=await request(ticket,'/prontuarios/'+record.id+'/versoes?pagina='+versionPage+'&limite=10');
            if(!append)el('versoes').replaceChildren();
            for(const v of result.itens){
                const article=doc.createElement('article');
                const types={rascunho:'Rascunho',finalizacao:'Finalizado',adendo:'Adendo',descarte:'Descartado'};
                addText(article,'h3','Versão '+v.versao+' · '+(types[v.tipo]||'Registro'));
                addText(article,'p','Autoria: '+(v.autor_snapshot?.nome_exibicao||v.autor_snapshot?.nome||'Não informada')+' · '+String(v.criado_em??''));
                for(const [k,value] of Object.entries(v.conteudo||{}))if(value!=null)addText(article,'p',k+': '+String(value));
                el('versoes').append(article);
            }
            el('mais-versoes').hidden=!result.tem_proxima;
            versionPage++;
        }
        async function history(ticket,append=false){
            const result=await request(ticket,'/prontuarios/pacientes/'+selected.paciente_id+'?pagina='+historyPage+'&limite=10');
            if(!append)el('historico').replaceChildren();
            for(const item of result.itens){
                const button=addText(el('historico'),'button','Atendimento '+String(item.atendimento_inicio_em??'')+' · '+item.estado+' · v'+item.versao_atual);
                button.type='button';button.className='secondary';
                button.addEventListener('click',()=>{
                    if(busy)return;
                    if(dirty&&!win.confirm('Descartar alterações não salvas da tela?'))return;
                    const found=appointments.find(a=>String(a.id)===String(item.consulta_id));
                    if(found){el('consulta').value=String(found.id);openAppointment(found);}
                    else openHistorical(item.id);
                });
            }
            el('mais-historico').hidden=!result.tem_proxima;historyPage++;
        }
        async function detail(ticket,id,canEdit){
            const result=await request(ticket,'/prontuarios/'+id);
            record=result.registro;editable=canEdit;
            el('estado').textContent='Situação: '+record.estado+' · versão '+record.versao_atual;
            if(record.estado==='rascunho'&&editable)for(const f of fields)el(f).value=result.versao_atual?.conteudo?.[f]??'';
            versionPage=1;await versions(ticket);
        }
        async function openHistorical(id){
            if(!validId(id)||!selected)return;
            const ticket=gate.begin();clearRecord();busy=true;controls();
            try{el('paciente').textContent=selected.nome_paciente;await detail(ticket,id,false);await history(ticket);status('Histórico em modo somente leitura.');}
            catch(e){error(ticket,e);}finally{if(gate.current(ticket)){busy=false;controls();}}
        }
        async function openAppointment(row){
            const ticket=gate.begin();clearRecord();selected=row;busy=true;controls();
            try{
                el('paciente').textContent=row.nome_paciente+' · '+String(row.inicio_local||'');
                const found=await request(ticket,'/prontuarios/consultas/'+row.id);
                editable=found.editavel===true;
                if(found.registro)await detail(ticket,found.registro.id,editable);
                else el('estado').textContent='Nenhum registro iniciado para este atendimento.';
                await history(ticket);status('Atendimento carregado.');
            }catch(e){error(ticket,e);}finally{if(gate.current(ticket)){busy=false;controls();}}
        }
        async function load(){
            clearAll('Verificando acesso…');initial=context();
            if(!validContext()){status('Acesso restrito ao profissional em ambiente local de testes.');return;}
            const ticket=gate.begin();el('recarregar').disabled=true;
            try{
                const capability=await request(ticket,'/prontuarios/capacidade');
                if(capability.experimental!==true)throw Error('Ambiente inválido.');
                const rows=await request(ticket,'/consultas/minha-agenda');
                appointments=rows.filter(a=>validId(a.id)&&validId(a.paciente_id)&&eligible(a));
                for(const a of appointments)el('consulta').append(new win.Option(String(a.inicio_local||'')+' · '+a.nome_paciente,String(a.id)));
                el('contexto').textContent=session.activeClinic.nome||'Contexto profissional';
                page.hidden=false;status(appointments.length?'Selecione um atendimento.':'Nenhum atendimento elegível.');
            }catch(e){error(ticket,e);}finally{if(gate.current(ticket))el('recarregar').disabled=false;}
        }
        async function mutate(action){
            if(busy||conflicted||!editable||!selected)return;
            let path,method='POST',body;
            try{
                if(action==='criar'&&!record){path='/consultas/'+selected.id;body={conteudo:{}};}
                else if(record){
                    body={versao:Number(record.versao_atual)};path='/'+record.id;
                    if(action==='salvar'&&record.estado==='rascunho'){method='PATCH';path+='/rascunho';body.conteudo=clinicalPayload(Object.fromEntries(fields.map(f=>[f,el(f).value])));}
                    else if(action==='finalizar'&&record.estado==='rascunho'&&!dirty){if(!win.confirm('Finalizar o registro salvo? Alterações futuras exigirão adendo.'))return;path+='/finalizar';}
                    else if(action==='descartar'&&record.estado==='rascunho'){if(!win.confirm('Descartar o rascunho? O histórico será preservado.'))return;path+='/descartar-rascunho';}
                    else if(action==='adicionar'&&record.estado==='finalizado'){const texto=el('texto').value.trim(),motivo=el('motivo').value.trim();if(!texto||!motivo)throw Error('Informe motivo e texto.');path+='/adendos';body.conteudo={texto,motivo};}
                    else return;
                }else return;
            }catch(e){status(e.message);return;}
            const ticket=gate.begin();busy=true;controls();
            try{
                await request(ticket,'/prontuarios'+path,method,body);
                if(gate.current(ticket))await openAppointment(selected);
            }catch(e){error(ticket,e);}finally{if(gate.current(ticket)){busy=false;controls();}}
        }
        el('consulta').addEventListener('change',()=>{
            if(dirty&&!win.confirm('Descartar alterações não salvas da tela?')){el('consulta').value=String(selected?.id||'');return;}
            const row=appointments.find(a=>String(a.id)===el('consulta').value);
            if(row)openAppointment(row);else{gate.clear();clearRecord();selected=null;busy=false;controls();}
        });
        for(const f of [...fields,'motivo','texto'])el(f).addEventListener('input',()=>{dirty=true;controls();});
        for(const id of ['criar','salvar','finalizar','descartar','adicionar'])el(id).addEventListener('click',()=>mutate(id));
        for(const [id,fn] of [['mais-versoes',versions],['mais-historico',history]])el(id).addEventListener('click',async()=>{
            if(busy)return;const ticket=gate.begin();busy=true;controls();
            try{await fn(ticket,true);}catch(e){error(ticket,e);}finally{if(gate.current(ticket)){busy=false;controls();}}
        });
        for(const id of ['editor','adendo'])el(id).addEventListener('submit',event=>event.preventDefault());
        el('recarregar').addEventListener('click',()=>{if(!dirty||win.confirm('Descartar alterações não salvas da tela?'))load();});
        const hide=()=>clearAll('Tela clínica limpa. Verifique novamente o acesso.');
        win.addEventListener('pagehide',hide);win.addEventListener('storage',hide);
        doc.addEventListener('visibilitychange',()=>{if(doc.hidden)hide();});
        win.setInterval(async()=>{
            if(page.hidden||busy)return;
            if(context()!==initial||!validContext()){hide();return;}
            const ticket=gate.begin();busy=true;controls();
            try{const result=await request(ticket,'/prontuarios/capacidade');if(result.experimental!==true)hide();}
            catch(e){error(ticket,e);}finally{if(gate.current(ticket)){busy=false;controls();}}
        },30000);
        load();
    }
    return {mount,clinicalPayload,eligible,contextGate,loopback};
});
