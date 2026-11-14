const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { test } = require('node:test');

Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_USER: 'fixture_user', DB_PASSWORD: 'fixture_password',
    DB_DATABASE: 'fixture_database', JWT_SECRET: randomBytes(32).toString('hex'),
    MAIL_PROVIDER: 'disabled', APP_PUBLIC_ORIGIN: 'http://127.0.0.1:5500'
});

const pool = require('../config/database');
const mailer = require('../services/invitation-mailer');
const controller = require('../controllers/equipeController');
const { createInvitationToken, hashInvitationToken } = require('../support/invitation-token');
const invitationRateLimit = require('../middleware/invitationRateLimit');

function response() {
    return { statusCode: null, body: null, headers: {}, status(code) { this.statusCode=code; return this; }, json(body) { this.body=body; return this; }, set(name,value){this.headers[name]=value;return this;} };
}
function connection(execute) {
    return { execute, beginTransaction: async()=>{}, commit: async()=>{}, rollback: async()=>{}, release(){} };
}

test('token de convite tem entropia, formato URL-safe e hash SHA-256 determinístico', () => {
    const token = createInvitationToken();
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(hashInvitationToken(token), createHash('sha256').update(token).digest('hex'));
    assert.equal(hashInvitationToken('curto'), null);
});

test('política impede secretaria de conceder privilégio e limita-a a profissionais', () => {
    assert.equal(controller._private.mayManage('secretaria', 'profissional'), true);
    assert.equal(controller._private.mayManage('secretaria', 'administrador'), false);
    assert.equal(controller._private.mayManage('secretaria', 'secretaria'), false);
    assert.equal(controller._private.mayManage('administrador', 'administrador'), true);
});

test('listagem de equipe é sempre filtrada pela clínica ativa', async (t) => {
    t.mock.method(pool, 'execute', async (sql, params) => {
        assert.match(sql, /cu\.clinica_id = \?/); assert.deepEqual(params, [11]); return [[]];
    });
    const res=response(); await controller.list({tenant:{clinicId:11}},res);
    assert.equal(res.statusCode,200); assert.deepEqual(res.body,[]);
});

test('secretaria não cria convite administrativo antes de acessar o banco', async (t) => {
    const get=t.mock.method(pool,'getConnection'); const res=response();
    await controller.createInvitation({body:{email:'admin@example.test',papel:'administrador'},tenant:{clinicId:11,role:'secretaria'},userId:7},res);
    assert.equal(res.statusCode,403); assert.equal(get.mock.callCount(),0);
});

test('convite novo persiste apenas hash, usa tenant autenticado e não afirma entrega', async (t) => {
    const executions=[];
    const conn=connection(async(sql,params)=>{
        executions.push({sql,params});
        if (/SELECT nome FROM clinicas/.test(sql)) return [[{nome:'Clínica Teste'}]];
        if (/SELECT id FROM usuarios WHERE email/.test(sql)) return [[]];
        if (/INSERT INTO usuarios/.test(sql)) return [{insertId:70}];
        if (/SELECT id, papel, status FROM clinica_usuarios/.test(sql)) return [[]];
        if (/INSERT INTO clinica_usuarios/.test(sql)) return [{insertId:80}];
        if (/INSERT INTO convites_clinica/.test(sql)) return [{insertId:90}];
        return [{affectedRows:1}];
    });
    t.mock.method(pool,'getConnection',async()=>conn);
    t.mock.method(mailer,'sendInvitation',async()=>({delivered:false,reason:'provider_not_configured'}));
    const res=response(); await controller.createInvitation({body:{nome:'Pessoa',email:'PESSOA@example.test',papel:'profissional',clinica_id:999},tenant:{clinicId:11,role:'secretaria'},userId:7},res);
    assert.equal(res.statusCode,201); assert.equal(res.body.entrega,'nao_confirmada'); assert.match(res.body.message,/não confirmada/);
    assert.equal('token' in res.body, false);
    const insert=executions.find(({sql})=>/INSERT INTO convites_clinica/.test(sql));
    assert.equal(insert.params[0],11); assert.equal(insert.params[2],'pessoa@example.test'); assert.match(insert.params[4],/^[a-f0-9]{64}$/);
    assert.equal(executions.some(({params})=>params?.includes(999)),false);
});

test('aceitação de conta nova ativa usuário e vínculo em uma única transação', async (t) => {
    const token=createInvitationToken(); const executions=[];
    const conn=connection(async(sql,params)=>{
        executions.push({sql,params});
        if (/FROM convites_clinica i/.test(sql)) return [[{id:90,clinica_id:11,papel:'profissional',status:'pendente',expira_em:new Date(Date.now()+60000),vinculo_id:80,usuario_id:70,vinculo_status:'convite_pendente',usuario_status:'bloqueado'}]];
        return [{affectedRows:1}];
    });
    const commit=t.mock.method(conn,'commit'); t.mock.method(pool,'getConnection',async()=>conn);
    const res=response(); await controller.acceptInvitation({params:{token},body:{senha:'senha-segura-123'},headers:{}},res);
    assert.equal(res.statusCode,200); assert.equal(commit.mock.callCount(),1);
    assert.ok(executions.some(({sql})=>/WHERE i\.token_hash=\? FOR UPDATE/.test(sql)));
    assert.ok(executions.some(({sql,params})=>/UPDATE usuarios/.test(sql)&&params[1]===70));
    assert.ok(executions.some(({sql})=>/UPDATE clinica_usuarios SET status='ativo'/.test(sql)));
    assert.ok(executions.some(({sql})=>/UPDATE convites_clinica SET status='aceito'/.test(sql)));
});

test('conta existente autenticada ativa apenas o novo vínculo e preserva credencial', async (t) => {
    const token=createInvitationToken(); const executions=[];
    const conn=connection(async(sql,params)=>{
        executions.push({sql,params});
        if (/FROM convites_clinica i/.test(sql)) return [[{id:90,clinica_id:11,papel:'secretaria',status:'pendente',expira_em:new Date(Date.now()+60000),vinculo_id:80,usuario_id:70,vinculo_status:'convite_pendente',usuario_status:'ativo'}]];
        return [{affectedRows:1}];
    });
    t.mock.method(pool,'getConnection',async()=>conn); const res=response();
    await controller.acceptInvitation({params:{token},body:{senha:'ignorada-por-seguranca'},userId:70},res);
    assert.equal(res.statusCode,200);
    assert.equal(executions.some(({sql})=>/UPDATE usuarios/.test(sql)),false);
    assert.ok(executions.some(({sql})=>/UPDATE clinica_usuarios SET status='ativo'/.test(sql)));
});

test('reenvio invalida pendentes anteriores antes de criar token substituto', async (t) => {
    const executions=[];
    const oldDate=new Date(Date.now()-120000);
    const conn=connection(async(sql,params)=>{
        executions.push({sql,params});
        if (/SELECT i\.\*, c\.nome/.test(sql)) return [[{id:90,clinica_id:11,clinica_usuario_id:80,email_normalizado:'pessoa@example.test',papel:'profissional',status:'pendente',criado_em:oldDate,clinica_nome:'Clínica Teste'}]];
        if (/SELECT id, criado_em FROM convites_clinica/.test(sql)) return [[{id:90,criado_em:oldDate}]];
        if (/SELECT id, status FROM clinica_usuarios/.test(sql)) return [[{id:80,status:'convite_pendente'}]];
        if (/INSERT INTO convites_clinica/.test(sql)) return [{insertId:91}];
        if (/criado_por_usuario_id/.test(sql)) return [[]];
        return [{affectedRows:1}];
    });
    t.mock.method(pool,'getConnection',async()=>conn);
    t.mock.method(mailer,'sendInvitation',async()=>({delivered:true}));
    const res=response(); await controller.reissue({params:{id:'90'},tenant:{clinicId:11,role:'secretaria'},userId:7},res);
    assert.equal(res.statusCode,201); assert.equal(res.body.id,91);
    const revokeIndex=executions.findIndex(({sql})=>/UPDATE convites_clinica\s+SET status = 'revogado'/.test(sql));
    const insertIndex=executions.findIndex(({sql})=>/INSERT INTO convites_clinica/.test(sql));
    assert.ok(revokeIndex >= 0 && insertIndex > revokeIndex);
});

test('conta existente exige autenticação da própria identidade e preserva senha', async (t) => {
    const token=createInvitationToken(); const executions=[];
    const conn=connection(async(sql,params)=>{
        executions.push({sql,params});
        if (/FROM convites_clinica i/.test(sql)) return [[{id:90,clinica_id:11,papel:'profissional',status:'pendente',expira_em:new Date(Date.now()+60000),vinculo_id:80,usuario_id:70,vinculo_status:'convite_pendente',usuario_status:'ativo'}]];
        return [{affectedRows:1}];
    });
    const rollback=t.mock.method(conn,'rollback'); t.mock.method(pool,'getConnection',async()=>conn);
    const res=response(); await controller.acceptInvitation({params:{token},body:{senha:'nao-deve-usar'},userId:71},res);
    assert.equal(res.statusCode,401); assert.equal(rollback.mock.callCount(),1);
    assert.equal(executions.some(({sql})=>/UPDATE usuarios/.test(sql)),false);
});

test('convite revogado, expirado ou já aceito é recusado sem alteração', async (t) => {
    const token=createInvitationToken();
    const conn=connection(async(sql)=> /FROM convites_clinica i/.test(sql) ? [[{id:90,status:'revogado',vinculo_status:'convite_pendente',expira_em:new Date(Date.now()+60000)}]] : [{affectedRows:1}]);
    const rollback=t.mock.method(conn,'rollback'); t.mock.method(pool,'getConnection',async()=>conn);
    const res=response(); await controller.acceptInvitation({params:{token},body:{}},res);
    assert.equal(res.statusCode,410); assert.equal(rollback.mock.callCount(),1);
});

test('consulta pública rejeita token manipulado sem acessar o banco', async (t) => {
    const execute=t.mock.method(pool,'execute'); const res=response();
    await controller.inspectInvitation({params:{token:'manipulado'}},res);
    assert.equal(res.statusCode,404); assert.equal(execute.mock.callCount(),0);
});

test('consulta pública rejeita convite expirado', async (t) => {
    const token=createInvitationToken();
    t.mock.method(pool,'execute',async()=>[[{clinica:'Clínica Teste',papel:'profissional',status:'pendente',expira_em:new Date(Date.now()-1000),requer_senha:1}]]);
    const res=response(); await controller.inspectInvitation({params:{token}},res);
    assert.equal(res.statusCode,410);
});

test('revogação não alcança convite de outra clínica', async (t) => {
    const conn=connection(async(sql,params)=>{
        if (/SELECT id, papel, status/.test(sql)) { assert.deepEqual(params,[90,11]); return [[]]; }
        return [{affectedRows:1}];
    });
    t.mock.method(pool,'getConnection',async()=>conn); const res=response();
    await controller.revoke({params:{id:'90'},tenant:{clinicId:11,role:'administrador'},userId:7},res);
    assert.equal(res.statusCode,404);
});

test('falha ao criar token substituto desfaz toda a transação', async (t) => {
    t.mock.method(console, 'error');
    const oldDate=new Date(Date.now()-120000);
    const conn=connection(async(sql)=>{
        if (/SELECT i\.\*, c\.nome/.test(sql)) return [[{id:90,clinica_id:11,clinica_usuario_id:80,email_normalizado:'pessoa@example.test',papel:'profissional',status:'pendente',criado_em:oldDate,clinica_nome:'Clínica'}]];
        if (/SELECT id, criado_em FROM convites_clinica/.test(sql)) return [[{id:90,criado_em:oldDate}]];
        if (/criado_por_usuario_id/.test(sql) && /SELECT/.test(sql)) return [[]];
        if (/SELECT id, status FROM clinica_usuarios/.test(sql)) return [[{id:80,status:'convite_pendente'}]];
        if (/INSERT INTO convites_clinica/.test(sql)) throw new Error('fixture failure');
        return [{affectedRows:1}];
    });
    const rollback=t.mock.method(conn,'rollback'); const commit=t.mock.method(conn,'commit');
    t.mock.method(pool,'getConnection',async()=>conn); const res=response();
    await controller.reissue({params:{id:'90'},tenant:{clinicId:11,role:'administrador'},userId:7},res);
    assert.equal(res.statusCode,500); assert.equal(rollback.mock.callCount(),1); assert.equal(commit.mock.callCount(),0);
});

test('não permite desativar o último administrador ativo', async (t) => {
    const executions=[];
    const conn=connection(async(sql,params)=>{
        executions.push({sql,params});
        if (/SELECT id, usuario_id, papel, status/.test(sql)) return [[{id:80,usuario_id:70,papel:'administrador',status:'ativo'}]];
        if (/papel='administrador'/.test(sql)) return [[{id:80}]];
        return [[{id:11}]];
    });
    const rollback=t.mock.method(conn,'rollback'); t.mock.method(pool,'getConnection',async()=>conn);
    const res=response(); await controller.updateStatus({params:{id:'80'},body:{status:'inativo'},tenant:{clinicId:11,role:'administrador'},userId:70},res);
    assert.equal(res.statusCode,409); assert.equal(rollback.mock.callCount(),1);
    assert.match(executions[0].sql, /clinicas WHERE id=\? FOR UPDATE/);
    assert.ok(executions.some(({sql})=>/papel='administrador'.*FOR UPDATE/.test(sql)));
    assert.equal(executions.some(({sql})=>/UPDATE clinica_usuarios SET status/.test(sql)),false);
});

test('limitador público bloqueia força bruta após a cota por IP', () => {
    const req={ip:'203.0.113.77'};
    for (let attempt=0; attempt<30; attempt+=1) {
        const res=response(); let called=false;
        invitationRateLimit(req,res,()=>{called=true;}); assert.equal(called,true);
    }
    const denied=response(); invitationRateLimit(req,denied,()=>{});
    assert.equal(denied.statusCode,429); assert.ok(denied.headers['Retry-After']);
});
