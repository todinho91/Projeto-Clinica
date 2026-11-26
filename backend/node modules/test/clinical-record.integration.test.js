const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomBytes } = require('node:crypto');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../scripts/db/config');
const { runMigrations } = require('../scripts/db/migrator');
const enabled = process.env.CLINICAL_RECORD_INTEGRATION_TEST === '1';
const migrationsDir = path.join(__dirname, '..', '..', 'database', 'migrations');
const migrationName = '016_versioned_clinical_records.sql';

test('MySQL 8: upgrade 015, API clínica, versões, concorrência, isolamento e revogação', { skip: !enabled }, async () => {
    const browserEnabled=process.env.CLINICAL_RECORD_BROWSER_TEST==='1';
    if(browserEnabled){
        assert.equal(process.env.GITHUB_ACTIONS,'true','browser fixture exclusiva do CI');
        assert.equal(process.env.CI,'true');
    }
    const config = loadDatabaseConfig(process.env, 'TEST_DB_');
    // No DROP or reset: exact dedicated CI name AND an empty schema before any write.
    assert.equal(config.database, 'vitalis_prontuarios_ci_test');
    assert.ok(['127.0.0.1', 'localhost'].includes(config.host));
    assert.equal(Number(config.port), 3306);
    const setup = await mysql.createConnection({ ...config, multipleStatements: true, timezone: 'Z' });
    let pool, server, temp;
    try {
        const [[selected]] = await setup.query('SELECT DATABASE() AS db, VERSION() AS version');
        assert.equal(selected.db, config.database);
        assert.match(selected.version, /^8\./);
        const [[existing]] = await setup.execute('SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [config.database]);
        assert.equal(Number(existing.total), 0, 'schema deve estar vazio e ser exclusivo desta execução');
        temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vitalis-record-ci-'));
        for (const filename of await fs.readdir(migrationsDir)) {
            if (/^\d{3}_[a-z0-9_]+\.sql$/.test(filename) && filename < migrationName) {
                await fs.copyFile(path.join(migrationsDir, filename), path.join(temp, filename));
            }
        }
        const first = await runMigrations({ connection: setup, migrationsDir: temp, logger: { info() {} } });
        assert.equal(first.applied.length, 15);
        const [clinicRows] = await setup.query("INSERT INTO clinicas (nome, slug, status) VALUES ('Aurora Fictícia','aurora-record-test','ativa'),('Horizonte Fictícia','horizonte-record-test','ativa'),('Consultório Fictício','consultorio-record-test','ativa')");
        const a = Number(clinicRows.insertId), b = a + 1, own = a + 2;
        async function user(suffix) {
            const [result] = await setup.execute("INSERT INTO usuarios (nome, email, senha_hash, status, motivo_bloqueio) VALUES (?, ?, ?, 'ativo', 'nenhum')",
                ['Usuário Fictício ' + suffix, suffix + '@example.test', randomBytes(32).toString('hex')]);
            return Number(result.insertId);
        }
        const doctor = await user('medico-a'), other = await user('medico-b'), admin = await user('admin'), secretary = await user('secretaria'), patientUser = await user('paciente'), operator = await user('operador');
        async function member(clinic, uid, role) {
            await setup.execute("INSERT INTO clinica_usuarios (clinica_id, usuario_id, papel, status) VALUES (?, ?, ?, 'ativo')", [clinic, uid, role]);
            const [[row]] = await setup.execute('SELECT sessao_versao FROM clinica_usuarios WHERE clinica_id = ? AND usuario_id = ?', [clinic, uid]);
            return Number(row.sessao_versao);
        }
        const va = await member(a, doctor, 'profissional'), vb = await member(b, doctor, 'profissional'), vo = await member(own, doctor, 'profissional');
        const vOther = await member(a, other, 'profissional'), vAdmin = await member(a, admin, 'administrador'), vSecretary = await member(a, secretary, 'secretaria'), vPatient = await member(a, patientUser, 'paciente');
        await setup.execute("INSERT INTO operadores_plataforma (usuario_id, status) VALUES (?, 'ativo')", [operator]);
        await setup.execute("INSERT INTO identidades_profissionais (usuario_id,tipo_profissional,conselho_tipo,conselho_numero,conselho_uf,status_verificacao) VALUES (?,'Médico','CRM','FICTICIO-A','SP','verificada')", [doctor]);
        await setup.execute("INSERT INTO consultorios_profissionais (clinica_id,titular_usuario_id,status) VALUES (?,?,'ativo')", [own,doctor]);
        async function profile(clinic, uid, suffix) {
            const [row] = await setup.execute("INSERT INTO profissionais (clinica_id,usuario_id,nome_exibicao,tipo_profissional,conselho_tipo,conselho_numero,status) VALUES (?,?,'Médico Fictício','Médico','CRM',?,'ativo')", [clinic,uid,'FICTICIO-'+suffix]);
            return Number(row.insertId);
        }
        const pa = await profile(a, doctor, 'A'), pb = await profile(b, doctor, 'A'), po = await profile(own, doctor, 'A'), px = await profile(a, other, 'B');
        async function patient(clinic, uid = null) {
            const [row] = await setup.execute("INSERT INTO pacientes (clinica_id,usuario_id,nome,status) VALUES (?,?,'Paciente Fictício','ativo')", [clinic,uid]);
            return Number(row.insertId);
        }
        const patientA = await patient(a,patientUser), patientB = await patient(b), patientOwn = await patient(own);
        async function appointment(clinic, pid, prof, actor, day, status) {
            const start = day + ' 10:00:00', end = day + ' 10:30:00';
            const [row] = await setup.execute('INSERT INTO consultas (clinica_id,paciente_id,profissional_id,inicio_em,fim_em,status,criado_por_usuario_id) VALUES (?,?,?,?,?,?,?)', [clinic,pid,prof,start,end,status,actor]);
            return Number(row.insertId);
        }
        const ap = await appointment(a,patientA,pa,doctor,'2020-01-01','realizada');
        const apOther = await appointment(a,patientA,px,other,'2020-01-01','realizada');
        const apB = await appointment(b,patientB,pb,doctor,'2020-01-01','realizada');
        const apOwn = await appointment(own,patientOwn,po,doctor,'2020-01-01','realizada');
        const cancelled = await appointment(a,patientA,pa,doctor,'2020-01-02','cancelada');
        const future = await appointment(a,patientA,pa,doctor,'2099-01-01','agendada');
        const noShow = await appointment(a,patientA,pa,doctor,'2020-01-03','nao_compareceu');
        const discardAp = await appointment(a,patientA,pa,doctor,'2020-01-04','realizada');
        const cancelDraftAp = await appointment(a,patientA,pa,doctor,'2020-01-05','confirmada');
        const [before] = await setup.query('SELECT version,checksum FROM schema_migrations ORDER BY version');
        async function counts() {
            const [[row]] = await setup.query('SELECT (SELECT COUNT(*) FROM pacientes) AS pacientes,(SELECT COUNT(*) FROM consultas) AS consultas,(SELECT COUNT(*) FROM usuarios) AS usuarios,(SELECT COUNT(*) FROM profissionais) AS profissionais');
            return row;
        }
        const beforeCounts = await counts();
        // Synthetic only: install 016, simulate a committed first DDL of 017, verify refusal.
        await fs.copyFile(path.join(migrationsDir,migrationName),path.join(temp,migrationName));
        const sixteen=await runMigrations({connection:setup,migrationsDir:temp,logger:{info(){}}});
        assert.deepEqual(sixteen.applied,[migrationName]);
        const [pre017]=await setup.query('SELECT version,checksum FROM schema_migrations ORDER BY version');
        await setup.query('ALTER TABLE prontuario_versoes MODIFY autor_snapshot JSON NULL, MODIFY conteudo JSON NULL, ADD CONSTRAINT chk_prontuario_sem_texto_puro CHECK (autor_snapshot IS NULL AND conteudo IS NULL)');
        await assert.rejects(runMigrations({connection:setup,migrationsDir,logger:{info(){}}}),/MIGRATION_017_PARTIAL/);
        const [partialLedger]=await setup.query('SELECT version,checksum FROM schema_migrations ORDER BY version');
        assert.deepEqual(partialLedger,pre017);
        assert.deepEqual(await counts(),beforeCounts);
        // Reverse only the deliberately injected DDL in this empty synthetic table.
        const [[empty]]=await setup.query('SELECT COUNT(*) AS total FROM prontuario_versoes');
        assert.equal(Number(empty.total),0);
        await setup.query('ALTER TABLE prontuario_versoes DROP CHECK chk_prontuario_sem_texto_puro, MODIFY autor_snapshot JSON NOT NULL, MODIFY conteudo JSON NOT NULL');
        const upgrade = await runMigrations({ connection: setup, migrationsDir, logger: { info() {} } });
        assert.deepEqual(upgrade.applied,['017_clinical_record_encryption.sql','018_clinical_crypto_events.sql']);
        assert.equal(upgrade.skipped.length,16);
        assert.deepEqual(await counts(),beforeCounts);
        const [after] = await setup.query('SELECT version,checksum FROM schema_migrations ORDER BY version');
        assert.deepEqual(after.slice(0,15),before);
        const repeated = await runMigrations({ connection: setup, migrationsDir, logger: { info() {} } });
        assert.equal(repeated.applied.length,0);
        assert.equal(repeated.skipped.length,18);

        const secret = randomBytes(32).toString('hex');
        Object.assign(process.env,{ DB_HOST:config.host, DB_PORT:String(config.port), DB_USER:config.user,
            DB_PASSWORD:config.password, DB_DATABASE:config.database, JWT_SECRET:secret,
            VITALIS_CLINICAL_RECORDS_ENABLED:'1', NODE_ENV:'test', CLINICAL_FIXTURE_KEK:randomBytes(32).toString('base64'), MAIL_PROVIDER:'disabled',
            PATIENT_CPF_KEY_ID:'clinical-ci', PATIENT_CPF_ENCRYPTION_KEY:randomBytes(32).toString('base64'),
            PATIENT_CPF_INDEX_KEY:randomBytes(32).toString('base64') });
        const express = require('express'), jwt = require('jsonwebtoken');
        pool = require('../config/database');
        const app = express(); app.use(express.json()); app.use('/api',require('../routes'));
        if(browserEnabled)require('../support/clinical-browser-fixture').mountStatic(app);
        server = await new Promise((resolve,reject) => { const s = app.listen(browserEnabled?3000:0,'127.0.0.1',()=>resolve(s)); s.once('error',reject); });
        const url = 'http://127.0.0.1:'+server.address().port+'/api/prontuarios';
        const token = (uid, clinic, version) => jwt.sign({sub:String(uid),token_type:'clinic',clinic_id:clinic,membership_version:version},secret,{algorithm:'HS256',expiresIn:'10m'});
        const ta = token(doctor,a,va), tb = token(doctor,b,vb), to = token(doctor,own,vo), tx = token(other,a,vOther);
        async function request(auth, method, route, body) {
            const headers = { 'Content-Type':'application/json' };
            if(auth) headers.Authorization='Bearer '+auth;
            const response = await fetch(url+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
            assert.match(response.headers.get('cache-control') || '',/no-store/);
            return {status:response.status,body:await response.json()};
        }
        assert.equal((await request(ta,'GET','/1')).status,503);
        require('../support/clinical-record-crypto').enableSyntheticFixture();
        if(browserEnabled){
            const password=randomBytes(24).toString('hex');
            const hash=await require('bcryptjs').hash(password,10);
            await setup.execute('UPDATE usuarios SET senha_hash=? WHERE id IN (?,?)',[hash,doctor,secretary]);
            await require('../support/clinical-browser-fixture').runBrowser({
                setup,doctor,secretary,clinicA:a,clinicB:b,ap,apB,apOther,discardAp,password
            });
            return;
        }
        assert.deepEqual((await request(ta,'GET','/capacidade')).body,{experimental:true});
        assert.equal((await request(ta,'GET','/consultas/'+ap)).body.registro,null);
        assert.equal((await request(tb,'GET','/consultas/'+ap)).status,404);
        assert.equal((await request(tx,'GET','/consultas/'+ap)).status,404);
        const clinical = { conteudo:{queixa:'FICTICIO_CONTEUDO_PRIVADO',evolucao:'Evolução de teste',conduta:'Conduta de teste'} };
        assert.equal((await request(null,'GET','/1')).status,401);
        for (const t of [token(admin,a,vAdmin),token(secretary,a,vSecretary),token(patientUser,a,vPatient),token(operator,a,1)]) {
            assert.equal((await request(t,'POST','/consultas/'+ap,clinical)).status,403);
        }
        assert.equal((await request(tb,'POST','/consultas/'+ap,clinical)).status,404);
        assert.equal((await request(tx,'POST','/consultas/'+ap,clinical)).status,404);
        for(const id of [cancelled,future,noShow]) assert.equal((await request(ta,'POST','/consultas/'+id,clinical)).status,409);
        assert.equal((await request(ta,'POST','/consultas/'+ap,{...clinical,clinica_id:b})).status,400);
        // New record creation with an invalid fixture KEK must roll back and log a distinct event.
        const savedFixtureKek=process.env.CLINICAL_FIXTURE_KEK;
        process.env.CLINICAL_FIXTURE_KEK='invalid-fixture';
        const keyFailure=await request(ta,'POST','/consultas/'+ap,clinical);
        assert.equal(keyFailure.status,500);
        assert.equal(keyFailure.body.code,'RECORD_KEY_FAILURE');
        process.env.CLINICAL_FIXTURE_KEK=savedFixtureKek;
        const [[noRecord]]=await setup.execute('SELECT COUNT(*) AS total FROM prontuario_registros WHERE clinica_id=? AND consulta_id=?',[a,ap]);
        assert.equal(Number(noRecord.total),0);
        const [[keyEvent]]=await setup.query("SELECT COUNT(*) AS total FROM prontuario_negativas WHERE codigo='RECORD_KEY_FAILURE'");
        assert.equal(Number(keyEvent.total),1);
        process.env.VITALIS_CLINICAL_RECORDS_ENABLED='0';
        assert.equal((await request(ta,'POST','/consultas/'+ap,clinical)).status,503);
        process.env.VITALIS_CLINICAL_RECORDS_ENABLED='1';
        process.env.NODE_ENV='production';
        assert.equal((await request(ta,'POST','/consultas/'+ap,clinical)).status,503);
        process.env.NODE_ENV='test';
        const created = await Promise.all([request(ta,'POST','/consultas/'+ap,clinical),request(ta,'POST','/consultas/'+ap,clinical)]);
        assert.deepEqual(created.map(x=>x.status).sort(),[201,409]);
        const id = created.find(x=>x.status===201).body.id;
        assert.equal(Number((await request(ta,'GET','/consultas/'+ap)).body.registro.id),id);
        assert.equal((await request(ta,'GET','/'+id)).body.versao_atual.conteudo.queixa,clinical.conteudo.queixa);
        const [[plainColumns]] = await setup.execute('SELECT autor_snapshot,conteudo FROM prontuario_versoes WHERE clinica_id=? AND registro_id=? AND versao=1',[a,id]);
        assert.deepEqual(plainColumns,{autor_snapshot:null,conteudo:null});
        await assert.rejects(setup.execute("UPDATE prontuario_versoes SET conteudo=JSON_OBJECT('x','fixture') WHERE clinica_id=? AND registro_id=? AND versao=1",[a,id]),error=>error.code==='ER_CHECK_CONSTRAINT_VIOLATED');
        const [[firstEnvelope]] = await setup.execute('SELECT chave_id,conteudo_cifrado,iv,auth_tag FROM prontuario_envelopes WHERE clinica_id=? AND registro_id=? AND versao=1',[a,id]);
        assert.equal(firstEnvelope.iv.length,12);
        assert.equal(firstEnvelope.auth_tag.length,16);
        assert.equal(firstEnvelope.conteudo_cifrado.includes(Buffer.from(clinical.conteudo.queixa)),false);
        assert.equal(firstEnvelope.conteudo_cifrado.includes(Buffer.from('Médico Fictício')),false);
        const changedTag=Buffer.from(firstEnvelope.auth_tag); changedTag[0]^=1;
        await setup.execute('UPDATE prontuario_envelopes SET auth_tag=? WHERE clinica_id=? AND registro_id=? AND versao=1',[changedTag,a,id]);
        assert.equal((await request(ta,'GET','/'+id)).status,500);
        await setup.execute('UPDATE prontuario_envelopes SET auth_tag=? WHERE clinica_id=? AND registro_id=? AND versao=1',[firstEnvelope.auth_tag,a,id]);
        const originalKek=process.env.CLINICAL_FIXTURE_KEK;
        process.env.CLINICAL_FIXTURE_KEK=randomBytes(32).toString('base64');
        assert.equal((await request(ta,'GET','/'+id)).status,500);
        process.env.CLINICAL_FIXTURE_KEK=originalKek;
        assert.equal((await request(ta,'GET','/'+id)).status,200);
        await assert.rejects(setup.execute('UPDATE prontuario_registros SET autor_usuario_id=? WHERE clinica_id=? AND id=?',[other,a,id]),error=>error.code==='ER_ROW_IS_REFERENCED_2'||error.code==='ER_NO_REFERENCED_ROW_2');
        assert.equal((await request(tx,'GET','/'+id)).status,404);
        assert.equal((await request(tb,'GET','/'+id+'/versoes')).status,404);
        assert.equal((await request(tb,'GET','/pacientes/'+patientA)).status,404);
        const noLeak = await request(tx,'GET','/pacientes/'+patientA);
        assert.equal(noLeak.status,200); assert.deepEqual(noLeak.body.itens,[]);
        const draftWrites = await Promise.all([request(ta,'PATCH','/'+id+'/rascunho',{versao:1,...clinical}),request(ta,'PATCH','/'+id+'/rascunho',{versao:1,...clinical})]);
        assert.deepEqual(draftWrites.map(x=>x.status).sort(),[200,409]);
        const finalized = await request(ta,'POST','/'+id+'/finalizar',{versao:2});
        assert.equal(finalized.status,200);
        assert.equal((await request(ta,'PATCH','/'+id+'/rascunho',{versao:3,...clinical})).status,409);
        assert.equal((await request(ta,'POST','/'+id+'/descartar-rascunho',{versao:3})).status,409);
        await setup.execute("UPDATE profissionais SET nome_exibicao = 'Nome Novo Fictício' WHERE clinica_id = ? AND id = ?",[a,pa]);
        // Rotate only the fixture DEK; the next append creates a new random key.
        await setup.execute('UPDATE prontuario_chaves SET ativa=NULL WHERE clinica_id=? AND ativa=1',[a]);
        const addendum = await request(ta,'POST','/'+id+'/adendos',{versao:3,conteudo:{texto:'Adendo fictício',motivo:'Correção fictícia'}});
        assert.equal(addendum.status,200);
        const history = await request(ta,'GET','/'+id+'/versoes');
        assert.equal(history.status,200);
        assert.deepEqual(history.body.itens.map(v=>v.tipo),['adendo','finalizacao','rascunho','rascunho']);
        assert.equal(history.body.itens[1].conteudo.queixa,clinical.conteudo.queixa);
        assert.equal(history.body.itens[1].autor_snapshot.nome_exibicao,'Médico Fictício');
        assert.equal(history.body.itens[0].autor_snapshot.nome_exibicao,'Nome Novo Fictício');
        const [encryptedVersions] = await setup.execute('SELECT versao,chave_id,iv FROM prontuario_envelopes WHERE clinica_id=? AND registro_id=? ORDER BY versao',[a,id]);
        assert.equal(encryptedVersions.length,4);
        assert.equal(encryptedVersions[0].chave_id,encryptedVersions[2].chave_id);
        assert.notEqual(encryptedVersions[2].chave_id,encryptedVersions[3].chave_id);
        assert.equal(new Set(encryptedVersions.map(v=>v.iv.toString('hex'))).size,4);
        assert.equal(Object.hasOwn(history.body.itens[0],'conteudo_cifrado'),false);
        assert.equal((await request(ta,'GET','/'+id+'/versoes?limite=1')).body.tem_proxima,true);
        const [[unchangedAppointment]] = await setup.execute('SELECT status FROM consultas WHERE id=?',[ap]);
        assert.equal(unchangedAppointment.status,'realizada');

        assert.equal((await request(tb,'POST','/consultas/'+apB,clinical)).status,201);
        assert.equal((await request(to,'POST','/consultas/'+apOwn,clinical)).status,201);
        assert.equal((await request(to,'GET','/'+id)).status,404);
        const [activeKeys] = await setup.query('SELECT clinica_id,chave_id,dek_protegida FROM prontuario_chaves WHERE ativa=1');
        assert.equal(activeKeys.length,3);
        assert.equal(new Set(activeKeys.map(k=>k.chave_id)).size,3);
        assert.equal(new Set(activeKeys.map(k=>k.dek_protegida.toString('hex'))).size,3);
        assert.equal((await request(tx,'POST','/consultas/'+apOther,clinical)).status,201);
        assert.equal((await request(ta,'GET','/pacientes/'+patientA)).body.itens.length,1);
        await assert.rejects(setup.execute('UPDATE consultas SET profissional_id=? WHERE id=?',[px,ap]), error=>error.code==='ER_ROW_IS_REFERENCED_2');
        const discard = await request(ta,'POST','/consultas/'+discardAp,{conteudo:{}});
        assert.equal(discard.status,201);
        assert.equal((await request(ta,'POST','/'+discard.body.id+'/finalizar',{versao:1})).status,422);
        assert.equal((await request(ta,'POST','/'+discard.body.id+'/descartar-rascunho',{versao:1})).status,200);
        assert.equal((await request(ta,'GET','/'+discard.body.id+'/versoes')).body.itens.length,2);
        const draft = await request(ta,'POST','/consultas/'+cancelDraftAp,clinical);
        assert.equal(draft.status,201);
        await setup.beginTransaction();
        let cancellationResult;
        try {
            await setup.execute("UPDATE consultas SET status='cancelada' WHERE id=?",[cancelDraftAp]);
            cancellationResult=request(ta,'POST','/'+draft.body.id+'/finalizar',{versao:1});
            await new Promise(resolve=>setTimeout(resolve,100));
            await setup.commit();
        } catch (error) { await setup.rollback(); throw error; }
        assert.equal((await cancellationResult).status,409);
        assert.equal((await request(ta,'GET','/'+draft.body.id)).status,404);

        // A trigger guarantees failure even with prior successful audit rows. Only disposable CI DB.
        await setup.query("CREATE TRIGGER record_ci_audit_failure BEFORE INSERT ON auditoria FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture'");
        try {
            assert.equal((await request(ta,'POST','/'+id+'/adendos',{versao:4,conteudo:{texto:'Não persistir',motivo:'Fixture'}})).status,500);
            assert.equal((await request(ta,'GET','/'+id)).status,500);
        } finally { await setup.query('DROP TRIGGER record_ci_audit_failure'); }
        const [[preserved]] = await setup.execute('SELECT versao_atual FROM prontuario_registros WHERE id=?',[id]);
        assert.equal(Number(preserved.versao_atual),4);
        const [[versions]] = await setup.execute('SELECT COUNT(*) AS total FROM prontuario_versoes WHERE registro_id=?',[id]);
        assert.equal(Number(versions.total),4);
        const [[logs]] = await setup.query("SELECT COUNT(*) AS total FROM auditoria WHERE CAST(metadados AS CHAR) LIKE '%FICTICIO_CONTEUDO_PRIVADO%'");
        assert.equal(Number(logs.total),0);
        await setup.beginTransaction();
        let revokedWrite;
        try {
            await setup.execute("UPDATE clinica_usuarios SET status='inativo',sessao_versao=sessao_versao+1 WHERE clinica_id=? AND usuario_id=?",[a,doctor]);
            revokedWrite=request(ta,'POST','/'+id+'/adendos',{versao:4,conteudo:{texto:'Não gravar',motivo:'Revogação'}});
            await new Promise(resolve=>setTimeout(resolve,100));
            await setup.commit();
        } catch (error) { await setup.rollback(); throw error; }
        assert.equal((await revokedWrite).status,403);
        assert.equal((await request(ta,'GET','/'+id)).status,403);
        const [[stillPreserved]] = await setup.execute('SELECT versao_atual FROM prontuario_registros WHERE id=?',[id]);
        assert.equal(Number(stillPreserved.versao_atual),4);
        const [denials]=await setup.query('SELECT codigo,COUNT(*) AS total FROM prontuario_negativas GROUP BY codigo');
        for(const code of ['RECORD_FORBIDDEN','RECORD_NOT_FOUND','RECORD_INTEGRITY']) assert.ok(denials.some(row=>row.codigo===code && Number(row.total)>0));
        assert.equal((await request(tb,'GET','/pacientes/'+patientB)).status,200);
        await setup.execute("UPDATE identidades_profissionais SET status_verificacao='suspensa' WHERE usuario_id=?",[doctor]);
        assert.equal((await request(to,'GET','/pacientes/'+patientOwn)).status,403);
    } finally {
        if(server) await new Promise(resolve=>server.close(resolve));
        await pool?.end();
        await setup.end();
        if(temp) await fs.rm(temp,{recursive:true,force:true});
    }
});
