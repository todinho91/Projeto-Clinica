const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_USER: 'fixture_user', DB_PASSWORD: 'fixture_password',
    DB_DATABASE: 'fixture_database', JWT_SECRET: randomBytes(32).toString('hex'),
    APP_PUBLIC_ORIGIN: 'http://127.0.0.1:5500', MAIL_PROVIDER: 'disabled'
});

const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const authController = require('../controllers/authController');
const practiceController = require('../controllers/consultorioController');
const specialtyController = require('../controllers/especialidadeController');
const practiceTeamManager = require('../middleware/practiceTeamManager');
const institutionalOnly = require('../middleware/institutionalOnly');
const tenantContext = require('../middleware/tenant');
const core = require('../../../js/vitalis-client');

function response() {
    return {
        statusCode: null, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function transaction(execute) {
    return {
        execute, beginTransaction: async () => {}, commit: async () => {},
        rollback: async () => {}, release() {}
    };
}

test('cadastro autônomo cria somente identidade global pendente e não exige tenant ou paciente', async (t) => {
    const executions = [];
    const connection = transaction(async (sql, params) => {
        executions.push({ sql, params });
        if (/INSERT INTO usuarios/.test(sql)) return [{ insertId: 71 }];
        return [{ affectedRows: 1 }];
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    t.mock.method(bcrypt, 'hash', async () => 'hash-profissional-fixture');
    const commit = t.mock.method(connection, 'commit');
    const res = response();

    await authController.registerProfessional({ body: {
        nome: 'Dra. Ana Teste', email: 'ANA@example.test', senha: 'senha-segura-de-teste',
        tipo_profissional: 'Médica', conselho_tipo: 'crm',
        conselho_numero: '12345', conselho_uf: 'sp'
    } }, res);

    assert.equal(res.statusCode, 201);
    assert.equal(commit.mock.callCount(), 1);
    assert.ok(executions.some(({ sql, params }) => /INSERT INTO identidades_profissionais/.test(sql)
        && params[0] === 71 && params[2] === 'CRM' && params[4] === 'SP'));
    assert.equal(executions.some(({ sql }) => /INSERT INTO (?:clinica_usuarios|pacientes|profissionais)\b/.test(sql)), false);
});

test('falha na identidade desfaz a conta profissional parcial', async (t) => {
    const connection = transaction(async (sql) => {
        if (/INSERT INTO usuarios/.test(sql)) return [{ insertId: 71 }];
        throw Object.assign(new Error('fixture privada'), { code: 'ER_TEST_FAILURE' });
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    t.mock.method(bcrypt, 'hash', async () => 'hash-profissional-fixture');
    const rollback = t.mock.method(connection, 'rollback');
    const commit = t.mock.method(connection, 'commit');
    const res = response();
    await authController.registerProfessional({ body: {
        nome: 'Dra. Ana Teste', email: 'ana@example.test', senha: 'senha-segura-de-teste',
        tipo_profissional: 'Médica', conselho_tipo: 'CRM',
        conselho_numero: '12345', conselho_uf: 'SP'
    } }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(rollback.mock.callCount(), 1);
    assert.equal(commit.mock.callCount(), 0);
});

test('operador é revalidado na transação e decisão profissional fica auditada', async (t) => {
    const executions = [];
    const connection = transaction(async (sql, params) => {
        executions.push({ sql, params });
        if (/FROM operadores_plataforma/.test(sql)) return [[{ id: 9 }]];
        if (/FROM identidades_profissionais ip/.test(sql)) return [[{
            usuario_id: 71, status_verificacao: 'pendente', usuario_status: 'ativo'
        }]];
        return [{ affectedRows: 1 }];
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const commit = t.mock.method(connection, 'commit');
    const res = response();
    await practiceController.verifyIdentity({
        userId: 3, params: { userId: '71' }, body: { status_verificacao: 'verificada' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(commit.mock.callCount(), 1);
    assert.ok(executions.some(({ sql }) => /FOR UPDATE/.test(sql) && /operadores_plataforma/.test(sql)));
    assert.ok(executions.some(({ sql }) => /identidade_profissional_status_alterado/.test(sql)));
});

test('identidade suspensa perde acesso ao consultório mesmo com token de clínica anterior', async (t) => {
    t.mock.method(pool, 'execute', async () => [[{
        clinica_id: 20, papel: 'profissional', sessao_versao: 2,
        clinica_nome: 'Consultório Teste', consultorio_id: 20,
        consultorio_titular_usuario_id: 7,
        identidade_profissional_status: 'suspensa', consultorio_titular: 0
    }]]);
    const req = {
        userId: 7,
        auth: { tokenType: 'clinic', clinicId: 20, membershipVersion: 2 }
    };
    const res = response();
    const next = t.mock.fn();
    await tenantContext(req, res, next);
    assert.equal(res.statusCode, 403);
    assert.equal(next.mock.callCount(), 0);
    assert.match(res.body.error, /verificação profissional/);
});

test('titular cria especialidade e a vincula ao próprio perfil na mesma transação', async (t) => {
    const executions = [];
    const connection = transaction(async (sql, params) => {
        executions.push({ sql, params });
        if (/FROM clinica_usuarios cu/.test(sql)) return [[{
            papel: 'profissional', consultorio_id: 20, titular_profissional_id: 30,
            consultorio_titular: 1
        }]];
        if (/INSERT INTO especialidades/.test(sql)) return [{ insertId: 44 }];
        return [{ affectedRows: 1 }];
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await specialtyController.createSpecialty({
        userId: 7, auth: { membershipVersion: 2 }, workspaceOwner: true,
        tenant: { clinicId: 20, role: 'profissional', isPractice: true },
        body: { nome: 'Cardiologia' }
    }, res);
    assert.equal(res.statusCode, 201);
    assert.ok(executions.some(({ sql, params }) => /INSERT INTO profissional_especialidades/.test(sql)
        && params[0] === 20 && params[1] === 30 && params[2] === 44));
});

test('consultório bloqueia secretária, outros médicos e administradores nas rotas compartilhadas', () => {
    for (const role of ['secretaria', 'administrador', 'profissional']) {
        const res = response();
        practiceTeamManager({ tenant: { role, isPractice: true } }, res, () => {
            assert.fail('somente o titular deveria gerenciar a equipe');
        });
        assert.equal(res.statusCode, 403);
    }
    const owner = { tenant: {
        role: 'profissional', isPractice: true, isPracticeOwner: true
    } };
    let ownerAllowed = false;
    practiceTeamManager(owner, response(), () => { ownerAllowed = true; });
    assert.equal(ownerAllowed, true);

    const institutionalRoute = institutionalOnly('administrador', 'secretaria');
    for (const role of ['administrador', 'secretaria']) {
        const res = response();
        institutionalRoute({ tenant: { role, isPractice: true } }, res, () => assert.fail());
        assert.equal(res.statusCode, 403);
    }
});

test('navegação identifica titular e não confunde consultório com secretaria', () => {
    const owner = { papel: 'profissional', tipo_contexto: 'consultorio', titular: true };
    const secretary = { papel: 'secretaria', tipo_contexto: 'consultorio', titular: false };
    assert.equal(core.dashboardForRole(owner.papel, owner), 'consultorio.html');
    assert.equal(core.roleCanAccessPage(owner.papel, 'especialidades.html', owner), true);
    assert.equal(core.roleCanAccessPage(secretary.papel, 'equipe.html', secretary), false);
    assert.equal(core.roleCanAccessPage(secretary.papel, 'profissionais.html', secretary), false);
    const source = readFileSync(path.join(__dirname, '..', '..', '..', 'js', 'main.js'), 'utf8');
    assert.match(source, /Titular do consultório/);
    assert.match(source, /Consultório ativo/);
    assert.doesNotMatch(source, /VitalisCore\.isPracticeOwner\(clinic\)[\s\S]{0,100}Secretaria da clínica/);
});

test('cadastro e verificação profissional mantêm layout responsivo em 360 e 390 pixels', () => {
    const root = path.join(__dirname, '..', '..', '..');
    for (const page of ['cadastro-profissional.html', 'verificacao-profissionais.html']) {
        const html = readFileSync(path.join(root, page), 'utf8');
        assert.match(html, /name="viewport"/);
        assert.match(html, /col-(?:12|sm-|md-)|container/);
        assert.doesNotMatch(html, /min-width:\s*[4-9]\d{2}px/i);
    }
});

test('documentação MySQL usa somente variáveis TEST_DB_ para a integração M3-04', () => {
    const doc = readFileSync(path.join(
        __dirname, '..', '..', '..', 'docs', 'M3_04_VITALIS_PROFISSIONAL.md'
    ), 'utf8');
    assert.match(doc, /TEST_DB_HOST/);
    assert.match(doc, /TEST_DB_DATABASE=vitalis_consultorios_local_test/);
    assert.match(doc, /Não use `DB_DATABASE`/);
});
