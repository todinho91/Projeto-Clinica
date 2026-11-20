const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_USER: 'fixture_user', DB_PASSWORD: 'fixture_password',
    DB_DATABASE: 'fixture_database', PORT: '3000', JWT_SECRET: randomBytes(32).toString('hex'),
    APP_PUBLIC_ORIGIN: 'http://127.0.0.1:5500', CONFIRMATION_TTL_HOURS: '24'
});

const pool = require('../config/database');
const controller = require('../controllers/confirmacaoConsultaController');
const router = require('../routes');

function response() {
    return {
        statusCode: null, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function transaction(t, handler) {
    return {
        beginTransaction: t.mock.fn(async () => {}), commit: t.mock.fn(async () => {}),
        rollback: t.mock.fn(async () => {}), release: t.mock.fn(), execute: t.mock.fn(handler)
    };
}

test('token de confirmação usa entropia e hash SHA-256 sem persistir valor puro', async (t) => {
    let confirmationParams;
    const connection = transaction(t, async (sql, params) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'secretaria' }]];
        if (/clinic\.nome AS clinica_nome/.test(sql)) return [[{
            id: 51, versao: 3, status: 'agendada', inicio_em: '2032-05-10 17:00:00.000',
            clinica_nome: 'Clínica Aurora', timezone: 'America/Sao_Paulo',
            telefone: '43999998888', preferencia_contato: 'whatsapp', paciente_status: 'ativo'
        }]];
        if (/INSERT INTO confirmacoes_consulta \(/.test(sql)) {
            confirmationParams = params; return [{ insertId: 91 }];
        }
        if (/confirmacoes_consulta_eventos|UPDATE confirmacoes_consulta|INSERT INTO auditoria/.test(sql)) {
            return [{ affectedRows: 1, insertId: 1 }];
        }
        throw new Error(`SQL inesperado: ${sql}`);
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.requestConfirmation({
        userId: 7, tenant: { clinicId: 11, role: 'secretaria' },
        params: { id: '51' }, body: { versao: 3 }
    }, res);
    assert.equal(res.statusCode, 201);
    assert.match(confirmationParams[3], /^[a-f0-9]{64}$/);
    assert.match(res.body.whatsapp_url, /^https:\/\/wa\.me\/5543999998888\?text=/);
    assert.equal(res.body.estado_entrega, 'nao_enviado');
    assert.match(res.body.message, /não comprova envio nem entrega/);
    assert.equal(connection.commit.mock.callCount(), 1);
});

test('telefone sem preferência explícita por WhatsApp é recusado sem criar token', async (t) => {
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'administrador' }]];
        if (/clinic\.nome AS clinica_nome/.test(sql)) return [[{
            id: 51, versao: 1, status: 'agendada', inicio_em: '2032-05-10 17:00:00.000',
            clinica_nome: 'Clínica', timezone: 'America/Sao_Paulo', telefone: '43999998888',
            preferencia_contato: 'nenhum', paciente_status: 'ativo'
        }]];
        throw new Error('nenhuma escrita deveria ocorrer');
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.requestConfirmation({
        userId: 7, tenant: { clinicId: 11, role: 'administrador' },
        params: { id: '51' }, body: { versao: 1 }
    }, res);
    assert.equal(res.statusCode, 422);
    assert.equal(connection.rollback.mock.callCount(), 1);
});

test('tenant autenticado não solicita confirmação de consulta de outra clínica', async (t) => {
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'secretaria' }]];
        if (/clinic\.nome AS clinica_nome/.test(sql)) return [[]];
        throw new Error('nenhuma escrita deveria ocorrer');
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.requestConfirmation({
        userId: 8, tenant: { clinicId: 22, role: 'secretaria' },
        params: { id: '51' }, body: { versao: 1 }
    }, res);
    assert.equal(res.statusCode, 404);
});

test('resposta pública é atômica e o mesmo token não pode responder duas vezes', async (t) => {
    let state = 'preparada';
    const connection = transaction(t, async (sql, params) => {
        if (/WHERE cc\.token_hash = \? LIMIT 1 FOR UPDATE/.test(sql)) return [[{
            id: 91, clinica_id: 11, consulta_id: 51, consulta_versao: 1,
            estado: state, expira_em: new Date(Date.now() + 3600000), versao: 1, status: 'agendada'
        }]];
        if (/UPDATE confirmacoes_consulta/.test(sql)) {
            if (state !== 'preparada') return [{ affectedRows: 0 }];
            state = params[0]; return [{ affectedRows: 1 }];
        }
        if (/confirmacoes_consulta_eventos|INSERT INTO auditoria/.test(sql)) return [{ insertId: 1 }];
        throw new Error(`SQL inesperado: ${sql}`);
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const token = randomBytes(32).toString('base64url');
    const first = response();
    await controller.respondPublic({ params: { token }, body: { resposta: 'confirmada' } }, first);
    assert.equal(first.statusCode, 200);
    const repeated = response();
    await controller.respondPublic({ params: { token }, body: { resposta: 'recusada' } }, repeated);
    assert.equal(repeated.statusCode, 409);
    assert.equal(state, 'confirmada');
});

test('link expirado ou referente a versão anterior não altera resposta', async (t) => {
    for (const fixture of [
        { expira_em: new Date(Date.now() - 1000), consulta_versao: 2, versao: 2 },
        { expira_em: new Date(Date.now() + 3600000), consulta_versao: 1, versao: 2 }
    ]) {
        const connection = transaction(t, async (sql) => {
            if (/WHERE cc\.token_hash = \? LIMIT 1 FOR UPDATE/.test(sql)) return [[{
                id: 91, clinica_id: 11, consulta_id: 51, estado: 'preparada',
                status: 'agendada', inicio_em: '2032-05-10 17:00:00.000', ...fixture
            }]];
            throw new Error('nenhuma escrita deveria ocorrer');
        });
        t.mock.method(pool, 'getConnection', async () => connection);
        const res = response();
        await controller.respondPublic({
            params: { token: randomBytes(32).toString('base64url') }, body: { resposta: 'confirmada' }
        }, res);
        assert.equal(res.statusCode, 409);
        assert.equal(connection.execute.mock.calls.some((call) => /UPDATE confirmacoes_consulta/.test(call.arguments[0])), false);
        t.mock.restoreAll();
    }
});

test('somente administrador e secretaria acessam operações administrativas de confirmação', () => {
    for (const pathName of [
        '/consultas/:id/confirmacoes', '/consultas/:id/confirmacoes/manual'
    ]) {
        const route = router.stack.find((layer) => layer.route?.path === pathName && layer.route.methods.post);
        assert.ok(route);
        for (const role of ['paciente', 'profissional']) {
            const res = response(); let next = false;
            route.route.stack[0].handle({ tenant: { role } }, res, () => { next = true; });
            assert.equal(res.statusCode, 403); assert.equal(next, false);
        }
    }
});

test('resposta manual não altera status clínico e mantém trilha auditável', async (t) => {
    const sqlCalls = [];
    const connection = transaction(t, async (sql) => {
        sqlCalls.push(sql);
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'secretaria' }]];
        if (/SELECT id, versao, status, inicio_em FROM consultas/.test(sql)) return [[{
            id: 51, versao: 2, status: 'confirmada', inicio_em: '2032-05-10 17:00:00.000'
        }]];
        if (/INSERT INTO confirmacoes_consulta \(/.test(sql)) return [{ insertId: 92 }];
        if (/confirmacoes_consulta_eventos|UPDATE confirmacoes_consulta|INSERT INTO auditoria/.test(sql)) {
            return [{ affectedRows: 1, insertId: 1 }];
        }
        throw new Error(`SQL inesperado: ${sql}`);
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.manualResponse({
        userId: 7, tenant: { clinicId: 11, role: 'secretaria' }, params: { id: '51' },
        body: { versao: 2, resposta: 'recusada' }
    }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(sqlCalls.some((sql) => /UPDATE consultas SET status/.test(sql)), false);
    assert.equal(sqlCalls.some((sql) => /INSERT INTO auditoria/.test(sql)), true);
});

test('migration e interface preservam separação entre confirmação, atendimento e entrega', async () => {
    const root = path.join(__dirname, '..', '..', '..');
    const [migration, page, main, controllerSource] = await Promise.all([
        fs.readFile(path.join(root, 'backend/database/migrations/010_appointment_confirmations.sql'), 'utf8'),
        fs.readFile(path.join(root, 'confirmacao-consulta.html'), 'utf8'),
        fs.readFile(path.join(root, 'js/main.js'), 'utf8'),
        fs.readFile(path.join(root, 'backend/node modules/controllers/confirmacaoConsultaController.js'), 'utf8')
    ]);
    assert.match(migration, /token_hash CHAR\(64\)/);
    assert.doesNotMatch(migration, /token_(?:puro|plain|texto)/i);
    assert.match(migration, /estado_entrega ENUM\('nao_enviado', 'aceito_provedor', 'entrega_confirmada', 'falha'\)/);
    assert.match(migration, /canal ENUM\('whatsapp', 'aplicativo', 'push', 'manual'\)/);
    assert.match(page, /intenção.*não registra atendimento realizado nem falta/i);
    assert.match(controllerSource, /Abrir o WhatsApp não comprova envio nem entrega/);
    assert.match(main, /Solicitar confirmação/);
    assert.match(main, /Registrar confirmação/);
});

test('página pública e ações são responsivas em 390 e 360 pixels', async () => {
    const root = path.join(__dirname, '..', '..', '..');
    const css = await fs.readFile(path.join(root, 'css/dashboard.css'), 'utf8');
    assert.match(css, /\.vitalis-confirmation-shell/);
    assert.match(css, /\.vitalis-confirmation-actions[^}]*grid-template-columns: 1fr 1fr/);
    assert.match(css, /@media \(max-width: 389\.98px\)[\s\S]*\.vitalis-confirmation-actions[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(css, /\.vitalis-calendar-detail-actions[^}]*flex-wrap: wrap/);
});
