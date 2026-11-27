// Only loaded by the guarded synthetic CI integration test, never by server.js.
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs/promises');
const project=path.resolve(__dirname,'../../..');
const origin='http://127.0.0.1:3000';
const clinicalPage='/prontuario-experimental.html';
const CSP="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
function mountStatic(app){
    // Whitelist only the files required for the clinical screen, never expose the repo or uploads.
    for(const file of ['prontuario-experimental.html','css/dashboard.css','css/prontuario-experimental.css','js/prontuario-experimental.js','js/vitalis-client.js']){
        app.get('/'+file,(req,res)=>{
            res.set({'Content-Security-Policy':CSP,'X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff',
                'Cache-Control':'no-store, private, max-age=0','Referrer-Policy':'no-referrer'});
            res.sendFile(path.join(project,file));
        });
    }
    app.get('/__browser-bootstrap',(req,res)=>res.set('Cache-Control','no-store').type('html').send('<!doctype html><html lang="pt-BR"><title>Fixture sintética</title><body>Fixture</body></html>'));
}
async function runBrowser({setup,doctor,secretary,clinicA,clinicB,clinicOwn,ap,apB,apOwn,apOther,discardAp,password}){
    const playwright=require(process.env.CLINICAL_PLAYWRIGHT_MODULE);
    const browser=await playwright.chromium.launch({headless:true});
    const artifacts=path.join(process.env.RUNNER_TEMP,'vitalis-clinical-visual');
    await fs.mkdir(artifacts,{recursive:true});
    const contexts=[];
    async function context(viewport){
        const c=await browser.newContext({viewport,serviceWorkers:'block'});
        contexts.push(c);return c;
    }
    async function login(c,email,clinic){
        const response=await c.request.post(origin+'/api/auth/login',{data:{email,senha:password}});
        assert.equal(response.status(),200,'login sintético');
        const identity=await response.json();
        const selected=await c.request.post(origin+'/api/auth/select-clinic',{headers:{Authorization:'Bearer '+identity.token},data:{clinica_id:clinic}});
        assert.equal(selected.status(),200,'seleção de clínica sintética');
        return {identity,clinic:await selected.json()};
    }
    async function openSession(c,session){
        const p=await c.newPage();
        await p.goto(origin+'/__browser-bootstrap');
        await p.evaluate(({identity,clinic})=>{
            sessionStorage.setItem('vitalis.identityToken',identity.token);
            sessionStorage.setItem('vitalis.clinicToken',clinic.token);
            sessionStorage.setItem('vitalis.activeClinic',JSON.stringify(clinic.clinica));
            sessionStorage.setItem('vitalis.user',JSON.stringify(identity.usuario));
            sessionStorage.setItem('vitalis.clinics',JSON.stringify(identity.clinicas));
        },session);
        const response=await p.goto(origin+clinicalPage);
        assert.equal(response.headers()['x-frame-options'],'DENY');
        assert.match(response.headers()['content-security-policy'],/frame-ancestors 'none'/);
        assert.match(response.headers()['cache-control'],/no-store/);
        return p;
    }
    const waitStatus=(p,text)=>p.waitForFunction(t=>document.getElementById('status').textContent.includes(t),text,{timeout:15000});
    const waitVersion=(p,n)=>p.waitForFunction(n=>document.getElementById('estado').textContent.endsWith('versão '+n)&&
        document.getElementById('status').textContent.includes('Atendimento carregado')&&!document.getElementById('consulta').disabled,n,{timeout:15000});
    const waitEnabled=(p,id)=>p.waitForFunction(id=>!document.getElementById(id).disabled&&!document.getElementById(id).hidden,id,{timeout:15000});
    const click=async(p,id)=>{await waitEnabled(p,id);await p.locator('#'+id).click();};
    const checkLayout=async p=>assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'sem rolagem horizontal');
    const resetScroll=async p=>{await p.evaluate(()=>{document.documentElement.scrollTop=0;document.body.scrollTop=0;window.scrollTo({top:0,left:0,behavior:'instant'});});await p.waitForFunction(()=>window.scrollY===0);};
    const noNarrativeInStorage=async(p,marker)=>assert.equal(await p.evaluate(m=>JSON.stringify([Object.entries(sessionStorage),Object.entries(localStorage),location.href]).includes(m),marker),false);
    try{
        const unauth=await context({width:1366,height:768});
        const naked=await unauth.newPage();
        await naked.goto(origin+clinicalPage);
        await waitStatus(naked,'Acesso restrito');
        assert.equal(await naked.locator('#workspace').isVisible(),false);
        const frame=await unauth.newPage();await frame.goto(origin+'/__browser-bootstrap');
        await frame.evaluate(src=>{const i=document.createElement('iframe');i.src=src;document.body.append(i);},origin+clinicalPage);
        await frame.waitForFunction(()=>document.querySelector('iframe')?.contentDocument===null,null,{timeout:10000});
        await unauth.close();
        const staff=await context({width:360,height:800});
        const staffPage=await openSession(staff,await login(staff,'secretaria@example.test',clinicA));
        await waitStatus(staffPage,'Acesso restrito');
        assert.equal(await staffPage.locator('#workspace').isVisible(),false);
        await staff.close();
        // The same verified physician works in their autonomous practice as well as clinics.
        // The practice has two synthetic locations; location-to-appointment attribution is
        // deliberately not asserted here because the appointment schema does not yet model it.
        const ownerContext=await context({width:360,height:800});
        const ownerSession=await login(ownerContext,'medico-a@example.test',clinicOwn);
        const ownerAuth={Authorization:'Bearer '+ownerSession.clinic.token};
        const locations=await ownerContext.request.get(origin+'/api/consultorio/contexto',{headers:ownerAuth});
        assert.equal(locations.status(),200);
        assert.equal((await locations.json()).locais.length,2);
        const ownerPage=await openSession(ownerContext,ownerSession);
        await waitStatus(ownerPage,'Selecione um atendimento');
        assert.equal(await ownerPage.locator('#clinical-nav a[href="prontuario-experimental.html"][aria-current="page"]').count(),1);
        assert.equal(await ownerPage.locator('#clinical-nav a[href="consultorio.html"]').count(),1);
        assert.equal(await ownerPage.locator('#consulta option[value="'+apOwn+'"]').count(),1);
        ownerPage.on('dialog',dialog=>dialog.accept());
        await ownerPage.locator('#abrir-menu').click();
        assert.equal(await ownerPage.locator('#clinical-nav a[aria-current="page"]').isVisible(),true);
        await ownerPage.locator('#fechar-menu').click();
        await ownerPage.locator('#consulta').selectOption(String(apOwn));
        await waitStatus(ownerPage,'Atendimento carregado');
        assert.equal((await ownerPage.locator('#clinic-name').textContent()).trim(),ownerSession.clinic.clinica.nome);
        await click(ownerPage,'criar');await waitVersion(ownerPage,1);
        await click(ownerPage,'descartar');await waitVersion(ownerPage,2);
        await checkLayout(ownerPage);
        await resetScroll(ownerPage);
        await ownerPage.screenshot({path:path.join(artifacts,'consultorio-autonomo-360-prontuario.png')});
        const secretarySession=await login(ownerContext,'secretaria@example.test',clinicOwn);
        const secretaryClinical=await ownerContext.request.get(origin+'/api/prontuarios/capacidade',{
            headers:{Authorization:'Bearer '+secretarySession.clinic.token}
        });
        assert.equal(secretaryClinical.status(),403,'secretária do consultório não acessa API clínica');
        const secretaryPracticePage=await openSession(ownerContext,secretarySession);
        await waitStatus(secretaryPracticePage,'Acesso restrito');
        assert.equal(await secretaryPracticePage.locator('#workspace').isVisible(),false);
        await ownerContext.close();
        for(const [label,viewport,clinic,appointment,foreign] of [
            ['desktop',{width:1366,height:768},clinicA,ap,apB],
            ['mobile',{width:360,height:800},clinicB,apB,ap]
        ]){
            const c=await context(viewport),session=await login(c,'medico-a@example.test',clinic);
            const auth={Authorization:'Bearer '+session.clinic.token};
            const page=await openSession(c,session);
            const errors=[];let consoleLeak=false;
            const marker='SINTETICO_BROWSER_'+label;
            page.on('pageerror',()=>errors.push('pageerror'));
            page.on('console',m=>{if(m.text().includes(marker))consoleLeak=true;});
            page.on('dialog',d=>d.accept());
            await waitStatus(page,'Selecione um atendimento');
            assert.equal(await page.locator('#clinical-nav').getAttribute('data-ready'),'true');
            assert.equal(await page.locator('.vitalis-brand-mark svg').count(),1);
            if(label==='desktop')assert.equal(await page.locator('#clinical-nav a[aria-current="page"]').isVisible(),true);
            if(viewport.width<=991){
                await page.locator('#abrir-menu').click();
                assert.equal(await page.locator('#abrir-menu').getAttribute('aria-expanded'),'true');
                assert.equal(await page.locator('#clinical-nav a[aria-current="page"]').isVisible(),true);
                await page.locator('#fechar-menu').click();
                assert.equal(await page.locator('#abrir-menu').getAttribute('aria-expanded'),'false');
                assert.equal(await page.evaluate(()=>document.activeElement?.id),'abrir-menu');
                await page.locator('#abrir-menu').click();
                await page.keyboard.press('Escape');
                assert.equal(await page.locator('#abrir-menu').getAttribute('aria-expanded'),'false');
                assert.equal(await page.locator('#vitalis-sidebar').evaluate(node=>node.inert),true);
            }
            assert.equal(await page.locator('#consulta option[value="'+foreign+'"]').count(),0);
            assert.equal(await page.locator('#consulta option[value="'+apOther+'"]').count(),0);
            const denied=await c.request.get(origin+'/api/prontuarios/consultas/'+foreign,{headers:auth});
            assert.equal(denied.status(),404);
            await page.locator('#consulta').selectOption(String(appointment));
            await waitStatus(page,'Atendimento carregado');
            assert.match(await page.locator('#paciente').textContent(),/Paciente Fictício/);
            assert.notEqual((await page.locator('#profissional').textContent()).trim(),'—');
            assert.match((await page.locator('#data-atendimento').textContent()).trim(),/\d{2}\/\d{2}\/\d{4} às \d{2}:\d{2} \(/);
            assert.notEqual((await page.locator('#contexto-clinica').textContent()).trim(),'—');
            assert.equal((await page.locator('#clinic-name').textContent()).trim(),session.clinic.clinica.nome);
            await click(page,'criar');await waitVersion(page,1);
            await waitEnabled(page,'salvar');await checkLayout(page);
            // Blank form screenshots: no clinical narratives, only fixtures.
            await resetScroll(page);
            await page.screenshot({path:path.join(artifacts,label+'-formulario-vazio.png')});
            await click(page,'finalizar');await waitStatus(page,'Registro incompleto');
            await page.locator('#queixa').fill(marker+' <img src=x onerror=alert(1)>');
            await page.locator('#evolucao').fill('Evolução sintética');
            await page.locator('#conduta').fill('Conduta sintética');
            assert.equal(await page.locator('#finalizar').isDisabled(),true);
            // Exercise the real visibility handler deterministically, not an OS notification.
            await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
            assert.equal(await page.locator('#workspace').isVisible(),false);
            await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
            await waitStatus(page,'Acesso revalidado');
            assert.match(await page.locator('#queixa').inputValue(),/SINTETICO_BROWSER_/);
            await click(page,'salvar');await waitVersion(page,2);
            await waitEnabled(page,'salvar');
            assert.match(await page.locator('#versoes').textContent(),/onerror=alert/);
            assert.equal(await page.locator('#versoes img').count(),0);
            await noNarrativeInStorage(page,marker);
            // Verify persisted data with a new document, not simply current DOM state.
            await page.reload();await waitStatus(page,'Selecione um atendimento');
            await page.locator('#consulta').selectOption(String(appointment));await waitVersion(page,2);
            assert.match(await page.locator('#queixa').inputValue(),/SINTETICO_BROWSER_/);
            await page.locator('#queixa').fill(marker+' edição local');
            // Introduce a real competing write immediately before the browser save reaches API.
            const lookup=await c.request.get(origin+'/api/prontuarios/consultas/'+appointment,{headers:auth});
            const rid=(await lookup.json()).registro.id;
            const saveUrl=origin+'/api/prontuarios/'+rid+'/rascunho';
            let competingStatus;
            await page.route(saveUrl,async route=>{
                const competing=await c.request.patch(saveUrl,{headers:auth,data:{versao:2,conteudo:{evolucao:'Versão concorrente sintética',conduta:'Conduta sintética'}}});
                competingStatus=competing.status();
                await route.continue();
            },{times:1});
            const conflictResponse=page.waitForResponse(r=>r.url()===saveUrl&&r.request().method()==='PATCH');
            await click(page,'salvar');assert.equal((await conflictResponse).status(),409);
            assert.equal(competingStatus,200);
            await waitStatus(page,'Conflito detectado');
            assert.equal(await page.locator('#queixa').inputValue(),marker+' edição local');
            assert.equal(await page.locator('#salvar').isDisabled(),true);
            await click(page,'revisar-conflito');await waitStatus(page,'Histórico atualizado');
            assert.match(await page.locator('#versoes').textContent(),/Versão concorrente sintética/);
            await click(page,'reaplicar');await waitStatus(page,'Edição retomada');
            assert.equal(await page.locator('#queixa').inputValue(),marker+' edição local');
            const current=await c.request.get(origin+'/api/prontuarios/consultas/'+appointment,{headers:auth});
            assert.equal(Number((await current.json()).registro.versao_atual),3,'sem reenvio automático');
            await click(page,'salvar');await waitVersion(page,4);
            await click(page,'finalizar');await waitVersion(page,5);
            await page.locator('#adendo').waitFor({state:'visible'});
            assert.equal(await page.locator('#editor').isVisible(),false);
            await page.locator('#motivo').fill('Motivo sintético');await page.locator('#texto').fill('Adendo sintético');
            await click(page,'adicionar');await waitVersion(page,6);
            assert.match(await page.locator('#versoes').textContent(),/Finalizado/);
            assert.match(await page.locator('#versoes').textContent(),/Adendo sintético/);
            await resetScroll(page);
            await page.screenshot({path:path.join(artifacts,label+'-historico-sintetico.png')});
            const [[appointmentState]]=await setup.execute('SELECT status FROM consultas WHERE id=?',[appointment]);
            assert.equal(appointmentState.status,'realizada');
            await noNarrativeInStorage(page,marker);await checkLayout(page);
            if(label==='desktop'){
                await page.setViewportSize({width:1024,height:768});await checkLayout(page);
                await page.locator('#consulta').selectOption(String(discardAp));await waitStatus(page,'Atendimento carregado');
                await click(page,'criar');await waitVersion(page,1);await click(page,'descartar');await waitVersion(page,2);
                assert.match(await page.locator('#estado').textContent(),/descartado/);
                assert.equal(await page.locator('#editor').isVisible(),false);
            }else{
                await page.setViewportSize({width:390,height:844});await checkLayout(page);
            }
            // Revocation on the actual backend; poll interval is 5s, deadline allows request/CI overhead.
            await setup.execute("UPDATE clinica_usuarios SET status='inativo',sessao_versao=sessao_versao+1 WHERE clinica_id=? AND usuario_id=?",[clinic,doctor]);
            const forbidden=await c.request.get(origin+'/api/prontuarios/capacidade',{headers:auth});
            assert.equal(forbidden.status(),403);
            await page.locator('#workspace').waitFor({state:'hidden',timeout:20000});
            assert.equal(await page.locator('#queixa').inputValue(),'');
            assert.equal(await page.locator('#versoes').textContent(),'');
            assert.equal(consoleLeak,false);assert.equal(errors.length,0);
            console.log('Browser synthetic flow passed: '+label);
            await c.close();
        }
    }finally{
        for(const c of contexts)await c.close().catch(()=>{});
        await browser.close();
    }
}
module.exports={mountStatic,runBrowser};
