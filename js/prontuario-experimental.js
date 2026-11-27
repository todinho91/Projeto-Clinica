(function(root,factory){
    const core=factory();
    if(typeof module==='object'&&module.exports) module.exports=core;
    else root.addEventListener('DOMContentLoaded',()=>core.mount(root));
})(typeof globalThis!=='undefined'?globalThis:this,()=>{
    const fields=['queixa','anamnese','antecedentes','alergias','medicamentos','avaliacao','evolucao','diagnostico','conduta'];
    const fieldLabels={queixa:'Queixa principal',anamnese:'Anamnese',antecedentes:'Antecedentes pessoais e familiares',alergias:'Alergias',medicamentos:'Medicamentos em uso',avaliacao:'Avaliação clínica',evolucao:'Evolução',diagnostico:'Diagnóstico',conduta:'Conduta e plano terapêutico'};
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
    function localDate(value){
        const match=String(value??'').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
        return match?`${match[3]}/${match[2]}/${match[1]} às ${match[4]}:${match[5]}`:'—';
    }
    function renderNavigation(doc,core,clinic,page='prontuario-experimental.html'){
        const navigation=doc.getElementById('clinical-nav');
        if(!navigation||!core?.roleCanAccessPage(clinic?.papel,page,clinic))return false;
        const paths={
            'consultorio.html':'M3 10.5 12 3l9 7.5M5.5 9v11h13V9M9 20v-6h6v6',
            'dashboard-medico.html':'M3 12h8V3H3v9Zm10 9h8v-9h-8v9Zm0-18v7h8V3h-8ZM3 21h8v-7H3v7Z',
            'prontuario-experimental.html':'M6 3h9l4 4v14H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm8 1v4h4M8 12h8M8 16h8',
            'pacientes.html':'M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-6v6M20.5 8h-6',
            'profissionais.html':'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0M18 4v5M15.5 6.5h5',
            'especialidades.html':'M4 4h16v4H4zM4 10h16v4H4zM4 16h10v4H4z',
            'disponibilidade.html':'M4 5h16v15H4zM8 3v4M16 3v4M4 10h16M8 13h.01M12 13h.01M16 13h.01',
            'agenda.html':'M4 5h16v16H4zM8 3v4M16 3v4M4 10h16M8 14h3M8 17h6',
            'calendario.html':'M4 5h16v16H4zM8 3v4M16 3v4M4 10h16M12 13v4l2 1',
            'equipe.html':'M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7-7.5a4 4 0 0 1 0 7.8M17 15h1a4 4 0 0 1 4 4v2',
            'configuracoes-clinica.html':'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.7 2.9-.2-.1a1.7 1.7 0 0 0-1.8 0l-.2.1h-3.4l-.1-.2a1.7 1.7 0 0 0-1.5-1l-.2-.1-1.7-2.9.1-.2a1.7 1.7 0 0 0 0-1.8l-.1-.2V10l.2-.1a1.7 1.7 0 0 0 1-1.5l.1-.2 2.9-1.7.2.1a1.7 1.7 0 0 0 1.8 0l.2-.1h3.4l.1.2a1.7 1.7 0 0 0 1.5 1l.2.1 1.7 2.9-.1.2a1.7 1.7 0 0 0 0 1.8l.1.2v3.4l-.2.1'
        };
        const fragment=doc.createDocumentFragment();
        for(const item of core.workspaceNavigation(clinic)){
            const link=doc.createElement('a');
            link.href=item.href;
            const icon=doc.createElementNS('http://www.w3.org/2000/svg','svg');
            icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');icon.setAttribute('focusable','false');
            icon.classList.add('clinical-nav-icon');
            const path=doc.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',paths[item.href]||'M12 5v14M5 12h14');icon.append(path);
            link.append(icon,doc.createTextNode(` ${item.label}`));
            if(item.href===page){link.classList.add('active');link.setAttribute('aria-current','page');}
            fragment.append(link);
        }
        navigation.replaceChildren(fragment);
        const brand=doc.querySelector('.vitalis-brand');
        const home=core.dashboardForRole(clinic?.papel,clinic);
        if(brand&&home)brand.href=home;
        return true;
    }
    function mount(win){
        const doc=win.document, el=id=>doc.getElementById(id), entry=el('prontuario-experimental-link');
        const page=el('workspace'); if(!page&&!entry)return;
        if(win.top!==win.self){
            if(page){page.hidden=true;el('status').textContent='Acesso em quadro incorporado bloqueado.';el('recarregar').disabled=true;}
            return;
        }
        const session=win.VitalisCore.createSession(win.sessionStorage);
        if(page&&session.activeClinic?.papel==='secretaria'){
            page.hidden=true;
            const home=win.VitalisCore.dashboardForRole('secretaria',session.activeClinic)||'dashboard-secretaria.html';
            win.location.replace(home+'?aviso=acesso-clinico-restrito');
            return;
        }
        const validContext=()=>loopback(win.location.hostname)&&['http:','https:'].includes(win.location.protocol)
            &&session.activeClinic?.papel==='profissional'
            &&win.VitalisCore.roleCanAccessPage('profissional','prontuario-experimental.html',session.activeClinic)
            &&session.clinicToken&&session.identityToken;
        const context=()=>JSON.stringify([session.activeClinic?.id,session.activeClinic?.papel,session.clinicToken,session.identityToken]);
        let initial=context();
        const gate=contextGate();
        const base='http://'+win.location.hostname+':3000/api';
        async function request(ticket,path,method='GET',body){
            if(!validContext()||context()!==initial||!gate.current(ticket))throw Error('Contexto alterado.');
            const headers={Authorization:'Bearer '+session.clinicToken};
            if(body!==undefined)headers['Content-Type']='application/json';
            const response=await win.fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([ticket.signal,AbortSignal.timeout(8000)]),cache:'no-store',credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
            if(!gate.current(ticket)||context()!==initial||!validContext())throw Error('Contexto alterado.');
            const result=await response.json();
            if(!response.ok){const error=Error('Operação não concluída.');error.status=response.status;error.code=result?.code;throw error;}
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
        const askConfirmation=message=>win.VitalisConfirm.ask(message);
        function formattedDate(value){
            const raw=String(value??'');
            if(!raw)return '—';
            const normalized=/Z$|[+-]\d{2}:?\d{2}$/.test(raw)?raw:raw.replace(' ','T')+'Z';
            const date=new Date(normalized);if(Number.isNaN(date.getTime()))return '—';
            const options={dateStyle:'short',timeStyle:'short'};
            const timezone=session.activeClinic?.fuso_horario||session.activeClinic?.timezone;
            if(timezone)options.timeZone=timezone;
            try{return new Intl.DateTimeFormat('pt-BR',options).format(date);}catch{return new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short'}).format(date);}
        }
        let appointments=[],selected=null,record=null,editable=false,dirty=false,busy=false,conflicted=false,professionalIdentityValid=false,versionPage=1,historyPage=1;
        let conflictLatest=null,masked=false,loaded=false;
        function clearRecord(){
            record=null;editable=false;dirty=false;conflicted=false;conflictLatest=null;versionPage=1;historyPage=1;
            for(const field of [...fields,'motivo','texto'])el(field).value='';
            for(const id of ['estado','paciente','profissional','especialidade','data-atendimento','contexto-clinica'])el(id).textContent='';
            for(const id of ['versoes','historico','registro-finalizado','complementacoes'])el(id).replaceChildren();
            for(const id of ['editor','adendo','criar','mais-versoes','mais-historico','conflito','registro-finalizado-bloco','complementacoes-bloco','historico-alteracoes'])el(id).hidden=true;
            el('historico-alteracoes').open=false;el('finalization-errors').hidden=true;el('identification-hint').hidden=true;
            for(const id of ['erro-evolucao','erro-conduta','erro-identificacao'])el(id).textContent='';
            for(const id of ['evolucao','conduta'])el(id).removeAttribute('aria-invalid');
        }
        function clearAll(message){
            gate.clear();clearRecord();selected=null;appointments=[];busy=false;loaded=false;masked=false;professionalIdentityValid=false;
            el('clinical-nav').dataset.ready='false';
            el('consulta').replaceChildren(new win.Option('Selecione uma consulta',''));
            page.hidden=true;el('contexto').textContent='';el('clinic-name').textContent='';el('clinic-kind').textContent='';
            el('profissional').textContent='—';el('especialidade').textContent='—';el('data-atendimento').textContent='—';el('contexto-clinica').textContent='—';
            el('recarregar').disabled=false;status(message);
        }
        function controls(){
            const draft=record?.estado==='rascunho'&&editable;
            const addendum=record?.estado==='finalizado'&&editable;
            el('criar').hidden=Boolean(record)||!selected||!editable||conflicted;
            el('editor').hidden=!draft;
            el('adendo').hidden=!addendum;
            el('registro-finalizado-bloco').hidden=record?.estado!=='finalizado';
            el('complementacoes-bloco').hidden=record?.estado!=='finalizado';
            el('historico-alteracoes').hidden=!record;
            el('conflito').hidden=!conflicted;
            el('reaplicar').disabled=busy||!conflictLatest;
            el('revisar-conflito').disabled=busy||!selected;
            el('descartar-local').disabled=busy;
            for(const id of ['criar','salvar','descartar','adicionar'])el(id).disabled=busy||conflicted||masked;
            for(const id of ['mais-versoes','mais-historico','consulta','recarregar'])el(id).disabled=busy||masked;
            el('finalizar').disabled=busy||dirty||!draft||conflicted||masked||!professionalIdentityValid;
            el('identification-hint').hidden=professionalIdentityValid||!draft;
            for(const id of [...fields,'motivo','texto'])el(id).readOnly=busy||conflicted||masked;
        }
        function conflict(){
            conflicted=true;conflictLatest=null;
            status('Conflito detectado. Texto local preservado em memória; revise a versão do servidor antes de continuar. Nenhum reenvio automático.');
            controls();
        }
        function error(ticket,e){
            if(!gate.current(ticket))return;
            if(e.status===401||e.status===403||e.status===404||e.status===503||e.status>=500||!e.status){
                clearAll(e.status===503?'Prontuário indisponível: ambiente sintético não habilitado.':'Acesso ou registro indisponível. Conteúdo removido da tela.');return;
            }
            if(e.status===409){conflict();}
            else if(e.status===422&&e.code==='RECORD_INCOMPLETE'){
                el('erro-evolucao').textContent=el('evolucao').value.trim()?'':'Preencha a evolução para finalizar.';
                el('erro-conduta').textContent=el('conduta').value.trim()?'':'Preencha a conduta e o plano terapêutico para finalizar.';
                el('erro-identificacao').textContent='A identificação profissional precisa estar validada no cadastro.';
                professionalIdentityValid=false;
                el('identification-hint').hidden=false;
                el('evolucao').setAttribute('aria-invalid',String(!el('evolucao').value.trim()));
                el('conduta').setAttribute('aria-invalid',String(!el('conduta').value.trim()));
                el('finalization-errors').hidden=false;
                status('Não foi possível finalizar. Confira a evolução, a conduta e a identificação profissional.');
            }else status('Dados inválidos. Revise os campos.');
        }
        function addText(parent,tag,text){const node=doc.createElement(tag);node.textContent=String(text??'');parent.append(node);return node;}
        function renderVersion(parent,v){
            const article=doc.createElement('article');article.dataset.kind=v.tipo;
            const types={rascunho:'Rascunho salvo',finalizacao:'Registro clínico finalizado',adendo:'Complementação / correção',descarte:'Rascunho descartado'};
            addText(article,'h3','Versão '+v.versao+' · '+(types[v.tipo]||'Registro'));
            const name=v.autor_snapshot?.nome_exibicao||v.autor_snapshot?.nome||'Não informada';
            const meta=addText(article,'p','Autoria: '+name+' · '+formattedDate(v.criado_em));meta.className='clinical-version-meta';
            for(const [key,value] of Object.entries(v.conteudo||{}))if(value!=null){
                const label=fieldLabels[key]||({texto:'Conteúdo do adendo',motivo:'Motivo do adendo'}[key]||'Informação clínica');
                const line=doc.createElement('p');const strong=addText(line,'strong',label+': ');strong.className='clinical-version-label';line.append(doc.createTextNode(String(value)));article.append(line);
            }
            parent.append(article);return article;
        }
        async function versions(ticket,append=false){
            if(!record)return;
            const result=await request(ticket,'/prontuarios/'+record.id+'/versoes?pagina='+versionPage+'&limite=10');
            if(!append){el('versoes').replaceChildren();el('complementacoes').replaceChildren();}
            for(const v of result.itens){
                if(v.tipo==='adendo'&&record.estado==='finalizado')renderVersion(el('complementacoes'),v);
                else if(v.versao!==Number(record.versao_atual)&&v.tipo!=='finalizacao')renderVersion(el('versoes'),v);
            }
            el('mais-versoes').hidden=!result.tem_proxima;
            el('mais-versoes').textContent='Mais histórico e complementações';
            versionPage++;
        }
        async function history(ticket,append=false){
            const result=await request(ticket,'/prontuarios/pacientes/'+selected.paciente_id+'?pagina='+historyPage+'&limite=10');
            if(!append)el('historico').replaceChildren();
            for(const item of result.itens){
                const button=addText(el('historico'),'button','Atendimento '+formattedDate(item.atendimento_inicio_em)+' · '+(item.estado==='rascunho'?'Rascunho':item.estado==='finalizado'?'Finalizado':item.estado)+' · v'+item.versao_atual);
                button.type='button';button.className='secondary';
                button.addEventListener('click',async()=>{
                    if(busy||masked||conflicted)return;
                    if(dirty&&!await askConfirmation('Descartar as alterações não salvas desta tela?'))return;
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
            const stateLabel={rascunho:'Rascunho em edição',finalizado:'Registro finalizado',descartado:'Rascunho descartado'}[record.estado]||record.estado;
            el('estado').textContent='Situação: '+stateLabel+' · versão '+record.versao_atual;
            if(record.estado==='rascunho'&&editable)for(const f of fields)el(f).value=result.versao_atual?.conteudo?.[f]??'';
            if(record.estado==='finalizado'&&result.versao_finalizada)renderVersion(el('registro-finalizado'),result.versao_finalizada);
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
                el('paciente').textContent=row.nome_paciente;
                el('profissional').textContent=row.nome_profissional||'—';
                el('especialidade').textContent=row.nome_especialidade||'Não informada';
                el('data-atendimento').textContent=localDate(row.inicio_local||row.inicio_em)+(row.timezone?' ('+row.timezone+')':'');
                el('contexto-clinica').textContent=session.activeClinic.nome||'—';
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
                professionalIdentityValid=capability.identificacao_profissional===true;
                if(!renderNavigation(doc,win.VitalisCore,session.activeClinic))throw Error('Acesso profissional não autorizado.');
                const rows=await request(ticket,'/consultas/minha-agenda');
                appointments=rows.filter(a=>validId(a.id)&&validId(a.paciente_id)&&eligible(a));
                for(const a of appointments)el('consulta').append(new win.Option(String(a.inicio_local||'')+' · '+a.nome_paciente,String(a.id)));
                el('contexto').textContent=session.activeClinic.nome||'Contexto profissional';
                el('clinic-name').textContent=session.activeClinic.nome||'Clínica';
                el('clinic-kind').textContent=session.activeClinic.tipo_contexto==='consultorio'?'Consultório profissional':'Área profissional';
                const switchState=win.VitalisCore.workspaceSwitchState(session.clinics,session.activeClinic);
                el('trocar-clinica').hidden=!switchState.visible;
                el('trocar-clinica').textContent=switchState.label;
                el('clinical-nav').dataset.ready='true';
                loaded=true;page.hidden=masked||doc.hidden;status(appointments.length?'Selecione um atendimento.':'Nenhum atendimento elegível.');
            }catch(e){error(ticket,e);}finally{if(gate.current(ticket))el('recarregar').disabled=false;}
        }
        async function mutate(action){
            if(busy||masked||doc.hidden||conflicted||!editable||!selected)return;
            let path,method='POST',body;
            try{
                if(action==='criar'&&!record){path='/consultas/'+selected.id;body={conteudo:{}};}
                else if(record){
                    body={versao:Number(record.versao_atual)};path='/'+record.id;
                    if(action==='salvar'&&record.estado==='rascunho'){method='PATCH';path+='/rascunho';body.conteudo=clinicalPayload(Object.fromEntries(fields.map(f=>[f,el(f).value])));}
                    else if(action==='finalizar'&&record.estado==='rascunho'&&!dirty){
                        const missing=[];
                        for(const [id,label,errorId] of [['evolucao','Evolução','erro-evolucao'],['conduta','Conduta e plano terapêutico','erro-conduta']]){
                            const empty=!el(id).value.trim();el(errorId).textContent=empty?'Preencha '+label.toLowerCase()+' para finalizar.':'';if(empty)missing.push(id);
                        }
                        if(missing.length){el('finalization-errors').hidden=false;el(missing[0]).focus();status('Antes de finalizar, preencha os campos obrigatórios indicados.');return;}
                        el('finalization-errors').hidden=true;
                        if(!await askConfirmation('Finalizar o registro clínico salvo? Depois disso, o conteúdo original ficará imutável; correções serão feitas por adendo.'))return;
                        path+='/finalizar';
                    }
                    else if(action==='descartar'&&record.estado==='rascunho'){if(!await askConfirmation('Descartar o rascunho? O histórico de versões será preservado.'))return;path+='/descartar-rascunho';}
                    else if(action==='adicionar'&&record.estado==='finalizado'){const texto=el('texto').value.trim(),motivo=el('motivo').value.trim();if(!texto||!motivo)throw Error('Informe motivo e texto.');path+='/adendos';body.conteudo={texto,motivo};}
                    else return;
                }else return;
            }catch(e){status(e.message);return;}
            const ticket=gate.begin();busy=true;controls();
            const messages={criar:'Rascunho iniciado.',salvar:'Rascunho salvo.',finalizar:'Registro clínico finalizado.',descartar:'Rascunho descartado; histórico preservado.',adicionar:'Complementação registrada.'};
            try{
                await request(ticket,'/prontuarios'+path,method,body);
                if(gate.current(ticket)){await openAppointment(selected);status(messages[action]||'Alteração concluída.');}
            }catch(e){error(ticket,e);}finally{if(gate.current(ticket)){busy=false;controls();}}
        }
        el('consulta').addEventListener('change',async()=>{
            if(masked||((dirty||conflicted)&&!await askConfirmation('Descartar as alterações não salvas desta tela?'))){el('consulta').value=String(selected?.id||'');return;}
            const row=appointments.find(a=>String(a.id)===el('consulta').value);
            if(row)openAppointment(row);else{gate.clear();clearRecord();selected=null;busy=false;controls();}
        });
        for(const f of [...fields,'motivo','texto'])el(f).addEventListener('input',()=>{
            dirty=true;
            if(f==='evolucao'&&el(f).value.trim()){el('erro-evolucao').textContent='';el(f).setAttribute('aria-invalid','false');}
            if(f==='conduta'&&el(f).value.trim()){el('erro-conduta').textContent='';el(f).setAttribute('aria-invalid','false');}
            if(!el('erro-evolucao').textContent&&!el('erro-conduta').textContent)el('finalization-errors').hidden=true;
            controls();
        });
        for(const id of ['criar','salvar','finalizar','descartar','adicionar'])el(id).addEventListener('click',()=>mutate(id));
        for(const [id,fn] of [['mais-versoes',versions],['mais-historico',history]])el(id).addEventListener('click',async()=>{
            if(busy||masked)return;const ticket=gate.begin();busy=true;controls();
            try{await fn(ticket,true);}catch(e){error(ticket,e);}finally{if(gate.current(ticket)){busy=false;controls();}}
        });
        for(const id of ['editor','adendo'])el(id).addEventListener('submit',event=>event.preventDefault());
        el('recarregar').addEventListener('click',async()=>{if((!dirty&&!conflicted)||await askConfirmation('Descartar as alterações não salvas desta tela e recarregar?'))load();});
        const sidebar=el('vitalis-sidebar'), menuButton=el('abrir-menu'), mobileMenu=win.matchMedia('(max-width: 991.98px)');
        const syncMenu=()=>{sidebar.inert=mobileMenu.matches&&sidebar.dataset.open!=='true';};
        const closeMenu=(restoreFocus=false)=>{sidebar.dataset.open='false';menuButton.setAttribute('aria-expanded','false');syncMenu();if(restoreFocus&&mobileMenu.matches)menuButton.focus();};
        mobileMenu.addEventListener?.('change',syncMenu);syncMenu();
        menuButton.addEventListener('click',()=>{
            const open=sidebar.dataset.open!=='true';sidebar.dataset.open=String(open);menuButton.setAttribute('aria-expanded',String(open));syncMenu();
            if(open&&mobileMenu.matches)sidebar.querySelector('a[href]')?.focus();
        });
        sidebar.addEventListener('keydown',event=>{
            if(!mobileMenu.matches||sidebar.dataset.open!=='true')return;
            if(event.key==='Escape'){event.preventDefault();closeMenu(true);return;}
            if(event.key!=='Tab')return;
            const items=[...sidebar.querySelectorAll('a[href],button:not(:disabled)')].filter(item=>!item.hidden);
            if(!items.length)return;
            const first=items[0],last=items.at(-1);
            if(event.shiftKey&&doc.activeElement===first){event.preventDefault();last.focus();}
            else if(!event.shiftKey&&doc.activeElement===last){event.preventDefault();first.focus();}
        });
        el('fechar-menu').addEventListener('click',()=>closeMenu(true));
        sidebar.addEventListener('click',event=>{if(event.target.closest('a[href]'))closeMenu();});
        el('logout-button').addEventListener('click',async()=>{if(dirty&&!await askConfirmation('Sair e apagar o texto local não salvo?'))return;hide();session.clear();win.location.assign('login.html');});
        el('descartar-local').addEventListener('click',async()=>{
            if(!busy&&selected&&await askConfirmation('Descartar somente o texto local não salvo e carregar o servidor?'))openAppointment(selected);
        });
        el('revisar-conflito').addEventListener('click',async()=>{
            if(busy||masked||!conflicted||!selected)return;
            const ticket=gate.begin();busy=true;conflictLatest=null;controls();
            try{
                const latest=await request(ticket,'/prontuarios/consultas/'+selected.id);
                if(!record||!latest.registro||String(latest.registro.id)!==String(record.id)||
                    latest.registro.estado!==record.estado||!latest.editavel){
                    status('O estado do atendimento mudou. Texto local mantido apenas para revisão; descarte local explícito para recarregar.');
                    return;
                }
                versionPage=1;await versions(ticket);
                conflictLatest=latest.registro;
                status('Histórico atualizado. Compare o texto local com a versão do servidor abaixo. Só confirme a retomada se tiver conciliado as diferenças.');
            }catch(e){error(ticket,e);}finally{if(gate.current(ticket)){busy=false;controls();}}
        });
        el('reaplicar').addEventListener('click',async()=>{
            if(busy||masked||!conflicted||!conflictLatest||!record)return;
            if(!await askConfirmation('Retomar a edição com o texto local sobre a versão revisada? Confirme somente após revisar as diferenças.'))return;
            record={...record,...conflictLatest};conflictLatest=null;conflicted=false;dirty=true;
            el('estado').textContent='Situação: '+record.estado+' · versão '+record.versao_atual;
            status('Edição retomada. Texto local ainda não salvo. Revise e salve explicitamente.');controls();
        });
        const hide=()=>clearAll('Tela clínica limpa. Verifique novamente o acesso.');
        win.addEventListener('pagehide',hide);win.addEventListener('storage',hide);
        win.addEventListener('beforeunload',event=>{
            if(dirty||conflicted){event.preventDefault();event.returnValue='';}
        });
        function mask(){
            if(!loaded)return;
            masked=true;page.hidden=true;el('contexto').textContent='';
            status('Conteúdo oculto por privacidade. Revalidação necessária.');controls();
        }
        async function verify(){
            if(!loaded||busy||doc.hidden)return;
            if(context()!==initial||!validContext()){hide();return;}
            const ticket=gate.begin();busy=true;controls();
            try{
                const result=await request(ticket,'/prontuarios/capacidade');
                if(result.experimental!==true){hide();return;}
                if(selected){
                    const latest=await request(ticket,'/prontuarios/consultas/'+selected.id);
                    if(record&&String(record.consulta_id)!==String(selected.id)){
                        await request(ticket,'/prontuarios/'+record.id);
                    }else if((record&&(!latest.registro||String(latest.registro.id)!==String(record.id)||
                        Number(latest.registro.versao_atual)!==Number(record.versao_atual)||latest.registro.estado!==record.estado))||
                        (!record&&latest.registro)||editable!==Boolean(latest.editavel)){
                        if(!conflicted||conflictLatest&&Number(conflictLatest.versao_atual)!==Number(latest.registro?.versao_atual))conflict();
                    }
                }
                if(gate.current(ticket)&&!doc.hidden){
                    if(masked&&!conflicted)status('Acesso revalidado. Edição em memória preservada.');
                    masked=false;page.hidden=false;el('contexto').textContent=session.activeClinic.nome||'Contexto profissional';
                }
            }catch(e){
                // A failed visibility check must not reveal a previously masked record.
                if(e.status===409&&!masked)conflict();
                else error(ticket,e);
                if(masked&&gate.current(ticket))clearAll('Não foi possível revalidar o acesso. Conteúdo removido da tela.');
            }finally{if(gate.current(ticket)){busy=false;controls();}}
        }
        doc.addEventListener('visibilitychange',()=>{if(doc.hidden)mask();else verify();});
        win.addEventListener('focus',()=>{if(masked)verify();});
        win.setInterval(verify,5000);
        load();
    }
    return {mount,clinicalPayload,eligible,contextGate,loopback,localDate,renderNavigation};
});
