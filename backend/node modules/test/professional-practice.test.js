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

const pool = require('../config/database');
const controller = require('../controllers/consultorioController');
const workspaceManager = require('../middleware/workspaceManager');
const core = require('../../../js/vitalis-client');

function response() {
    return {
        statusCode: null, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function connection(execute) {
    return {
        execute, beginTransaction: async () => {}, commit: async () => {},
        rollback: async () => {}, release() {}
    };
}

function provisionRequest(overrides = {}) {
    return {
        userId: 7,
        body: {
            nome: 'Consultório Dra. Ana', slug: 'consultorio-dra-ana',
            timezone: 'America/Sao_Paulo', nome_exibicao: 'Dra. Ana'
        },
        ...overrides
    };
}

test('migration 012 é aditiva, separa tenant de local e não reclassifica clínicas', () => {
    const sql = readFileSync(path.join(
        __dirname, '..', '..', 'database', 'migrations', '012_professional_practices.sql'
    ), 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS identidades_profissionais/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS consultorios_profissionais/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS consultorio_locais/);
    assert.match(sql, /catalogo_status ENUM\('privado', 'pendente', 'publicavel'\).*DEFAULT 'privado'/);
    assert.match(sql, /FOREIGN KEY \(clinica_id, titular_usuario_id\)[\s\S]*clinica_usuarios/);
    assert.doesNotMatch(sql, /ALTER TABLE clinicas|^\s*UPDATE\s+clinicas|^\s*DELETE\s+FROM|TRUNCATE|DROP TABLE/im);
});

test('somente titular explícito recebe capacidade de gestão sem virar administrador', () => {
    const middleware = workspaceManager('administrador', 'secretaria');
    let nextCalled = false;
    const ownerReq = {
        tenant: { clinicId: 12, role: 'profissional', isPracticeOwner: true }
    };
    middleware(ownerReq, response(), () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(ownerReq.workspaceOwner, true);
    assert.equal(ownerReq.tenant.role, 'profissional');

    for (const tenant of [
        { clinicId: 12, role: 'profissional' },
        { clinicId: 12, role: 'paciente' }
    ]) {
        const res = response();
        middleware({ tenant }, res, () => assert.fail('não deveria autorizar'));
        assert.equal(res.statusCode, 403);
    }
});

test('contexto do frontend distingue consultório titular sem ampliar clínica institucional', () => {
    const practice = {
        id: 12, papel: 'profissional', tipo_contexto: 'consultorio', titular: true
    };
    assert.equal(core.dashboardForRole('profissional', practice), 'consultorio.html');
    assert.equal(core.roleCanAccessPage('profissional', 'pacientes.html', practice), true);
    assert.equal(core.roleCanAccessPage('profissional', 'equipe.html', practice), true);
    assert.equal(core.roleCanAccessPage('profissional', 'pacientes.html', {
        id: 11, papel: 'profissional', tipo_contexto: 'clinica', titular: false
    }), false);
});

test('provisionamento exige identidade ativa e verificada antes de qualquer escrita', async (t) => {
    const executions = [];
    const conn = connection(async (sql, params) => {
        executions.push({ sql, params });
        if (/FROM usuarios u/.test(sql)) {
            return [[{ id: 7, status: 'ativo', status_verificacao: 'pendente' }]];
        }
        throw new Error('escrita inesperada');
    });
    const rollback = t.mock.method(conn, 'rollback');
    t.mock.method(pool, 'getConnection', async () => conn);
    const res = response();
    await controller.provision(provisionRequest(), res);
    assert.equal(res.statusCode, 403);
    assert.equal(rollback.mock.callCount(), 1);
    assert.equal(executions.some(({ sql }) => /^\s*INSERT\b/.test(sql)), false);
});

test('provisionamento cria consultório, vínculo profissional, perfil e auditoria na mesma transação', async (t) => {
    const executions = [];
    const conn = connection(async (sql, params) => {
        executions.push({ sql, params });
        if (/FROM usuarios u/.test(sql)) return [[{
            id: 7, status: 'ativo', status_verificacao: 'verificada',
            tipo_profissional: 'Médica', conselho_tipo: 'CRM', conselho_numero: '12345'
        }]];
        if (/FROM consultorios_profissionais cp/.test(sql)) return [[]];
        if (/SELECT id FROM clinicas WHERE slug/.test(sql)) return [[]];
        if (/INSERT INTO clinicas/.test(sql)) return [{ insertId: 20 }];
        if (/INSERT INTO profissionais/.test(sql)) return [{ insertId: 30 }];
        return [{ insertId: 40, affectedRows: 1 }];
    });
    const commit = t.mock.method(conn, 'commit');
    t.mock.method(pool, 'getConnection', async () => conn);
    const res = response();
    await controller.provision(provisionRequest({ body: {
        ...provisionRequest().body, clinica_id: 999, papel: 'administrador'
    } }), res);
    assert.equal(res.statusCode, 201);
    assert.equal(commit.mock.callCount(), 1);
    assert.match(executions.find(({ sql }) => /INSERT INTO clinica_usuarios/.test(sql)).sql,
        /'profissional', 'ativo'/);
    assert.ok(executions.some(({ sql }) => /INSERT INTO consultorios_profissionais/.test(sql)));
    assert.ok(executions.some(({ sql }) => /consultorio_provisionado/.test(sql)));
    assert.equal(executions.some(({ params }) => params?.includes(999)), false);
});

test('falha parcial no consultório provoca rollback e não confirma transação', async (t) => {
    const conn = connection(async (sql) => {
        if (/FROM usuarios u/.test(sql)) return [[{
            id: 7, status: 'ativo', status_verificacao: 'verificada',
            tipo_profissional: 'Médica', conselho_tipo: 'CRM', conselho_numero: '12345'
        }]];
        if (/FROM consultorios_profissionais cp/.test(sql) || /SELECT id FROM clinicas WHERE slug/.test(sql)) return [[]];
        if (/INSERT INTO clinicas/.test(sql)) return [{ insertId: 20 }];
        if (/INSERT INTO profissionais/.test(sql)) throw Object.assign(new Error('fixture'), { code: 'ER_TEST' });
        return [{ affectedRows: 1 }];
    });
    const rollback = t.mock.method(conn, 'rollback');
    const commit = t.mock.method(conn, 'commit');
    t.mock.method(pool, 'getConnection', async () => conn);
    const res = response();
    await controller.provision(provisionRequest(), res);
    assert.equal(res.statusCode, 500);
    assert.equal(rollback.mock.callCount(), 1);
    assert.equal(commit.mock.callCount(), 0);
});

test('titular cria local somente no tenant autenticado e registra auditoria', async (t) => {
    const executions = [];
    const conn = connection(async (sql, params) => {
        executions.push({ sql, params });
        if (/FROM consultorios_profissionais cp/.test(sql)) return [[{
            clinica_id: 20, titular_usuario_id: 7, status: 'ativo', clinica_status: 'ativa',
            vinculo_status: 'ativo', papel: 'profissional', usuario_status: 'ativo',
            profissional_status: 'ativo', profissional_id: 30
        }]];
        if (/INSERT INTO consultorio_locais/.test(sql)) return [{ insertId: 41 }];
        return [{ affectedRows: 1 }];
    });
    t.mock.method(pool, 'getConnection', async () => conn);
    const res = response();
    await controller.createLocation({
        userId: 7, tenant: { clinicId: 20, role: 'profissional' },
        body: { nome: 'Unidade Centro', endereco_linha: 'Rua Teste, 100', cidade: 'São Paulo', uf: 'SP', cep: '01001000', clinica_id: 999 }
    }, res);
    assert.equal(res.statusCode, 201);
    const insert = executions.find(({ sql }) => /INSERT INTO consultorio_locais/.test(sql));
    assert.equal(insert.params[0], 20);
    assert.equal(insert.params.includes(999), false);
    assert.ok(executions.some(({ sql }) => /local_atendimento_criado/.test(sql)));
});

test('interface do consultório é responsiva e não anuncia catálogo fictício', () => {
    const root = path.join(__dirname, '..', '..', '..');
    const practice = readFileSync(path.join(root, 'consultorio.html'), 'utf8');
    const start = readFileSync(path.join(root, 'vitalis-profissional.html'), 'utf8');
    const css = readFileSync(path.join(root, 'css', 'dashboard.css'), 'utf8');
    assert.match(practice, /viewport/);
    assert.match(practice, /href="pacientes\.html"/);
    assert.match(practice, /href="agenda\.html"/);
    assert.match(practice, /href="disponibilidade\.html"/);
    assert.match(practice, /href="equipe\.html"/);
    assert.match(start, /O consultório nasce privado/);
    assert.doesNotMatch(practice, /médicos disponíveis|catálogo disponível|buscar médicos/i);
    assert.match(css, /@media \(max-width: 575\.98px\)[\s\S]*vitalis-practice-shortcuts/);
});
