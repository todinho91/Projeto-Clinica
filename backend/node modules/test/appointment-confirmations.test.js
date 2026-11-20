const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
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
        if (/FROM confirmacoes_consulta\s+WHERE clinica_id/.test(sql)) return [[]];
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
    assert.match(decodeURIComponent(res.body.whatsapp_url), /confirmacao-consulta\.html#token=/);
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
        if (/SELECT cc\.clinica_id, cc\.consulta_id/.test(sql)) {
            return [[{ clinica_id: 11, consulta_id: 51, paciente_id: 31 }]];
        }
        if (/FROM pacientes WHERE/.test(sql)) return [[{
            id: 31, telefone: '43999998888', preferencia_contato: 'whatsapp', status: 'ativo'
        }]];
        if (/SELECT id FROM consultas/.test(sql)) return [[{ id: 51 }]];
        if (/WHERE cc\.token_hash = \? LIMIT 1 FOR UPDATE/.test(sql)) return [[{
            id: 91, clinica_id: 11, consulta_id: 51, consulta_versao: 1,
            estado: state, expira_em: new Date(Date.now() + 3600000), versao: 1,
            status: 'agendada', inicio_em: '2032-05-10 17:00:00.000'
        }]];
        if (/estado IN \('confirmada', 'recusada'\)/.test(sql)) return [[]];
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
    await controller.respondPublic({ body: { token, resposta: 'confirmada' } }, first);
    assert.equal(first.statusCode, 200);
    const repeated = response();
    await controller.respondPublic({ body: { token, resposta: 'recusada' } }, repeated);
    assert.equal(repeated.statusCode, 409);
    assert.equal(state, 'confirmada');
});

test('link expirado ou referente a versão anterior não altera resposta', async (t) => {
    for (const fixture of [
        { expira_em: new Date(Date.now() - 1000), consulta_versao: 2, versao: 2 },
        { expira_em: new Date(Date.now() + 3600000), consulta_versao: 1, versao: 2 }
    ]) {
        const connection = transaction(t, async (sql) => {
            if (/SELECT cc\.clinica_id, cc\.consulta_id/.test(sql)) {
                return [[{ clinica_id: 11, consulta_id: 51, paciente_id: 31 }]];
            }
            if (/FROM pacientes WHERE/.test(sql)) return [[{
                id: 31, telefone: '43999998888', preferencia_contato: 'whatsapp', status: 'ativo'
            }]];
            if (/SELECT id FROM consultas/.test(sql)) return [[{ id: 51 }]];
            if (/WHERE cc\.token_hash = \? LIMIT 1 FOR UPDATE/.test(sql)) return [[{
                id: 91, clinica_id: 11, consulta_id: 51, estado: 'preparada',
                status: 'agendada', inicio_em: '2032-05-10 17:00:00.000', ...fixture
            }]];
            if (/estado IN \('confirmada', 'recusada'\)/.test(sql)) return [[]];
            throw new Error('nenhuma escrita deveria ocorrer');
        });
        t.mock.method(pool, 'getConnection', async () => connection);
        const res = response();
        await controller.respondPublic({
            body: { token: randomBytes(32).toString('base64url'), resposta: 'confirmada' }
        }, res);
        assert.equal(res.statusCode, 409);
        assert.equal(connection.execute.mock.calls.some((call) => /UPDATE confirmacoes_consulta/.test(call.arguments[0])), false);
        t.mock.restoreAll();
    }
});

test('novo link não cria resposta pública contraditória para a mesma versão', async (t) => {
    const writes = [];
    const connection = transaction(t, async (sql) => {
        if (/SELECT cc\.clinica_id, cc\.consulta_id/.test(sql)) {
            return [[{ clinica_id: 11, consulta_id: 51, paciente_id: 31 }]];
        }
        if (/FROM pacientes WHERE/.test(sql)) return [[{
            id: 31, telefone: '43999998888', preferencia_contato: 'whatsapp', status: 'ativo'
        }]];
        if (/SELECT id FROM consultas/.test(sql)) return [[{ id: 51 }]];
        if (/WHERE cc\.token_hash = \? LIMIT 1 FOR UPDATE/.test(sql)) return [[{
            id: 92, clinica_id: 11, consulta_id: 51, consulta_versao: 1,
            estado: 'preparada', expira_em: new Date(Date.now() + 3600000), versao: 1,
            status: 'agendada', inicio_em: '2032-05-10 17:00:00.000'
        }]];
        if (/estado IN \('confirmada', 'recusada'\)/.test(sql)) {
            return [[{ id: 91, canal: 'whatsapp', estado: 'confirmada' }]];
        }
        if (/UPDATE confirmacoes_consulta|confirmacoes_consulta_eventos|INSERT INTO auditoria/.test(sql)) {
            writes.push(sql); return [{ affectedRows: 1, insertId: 1 }];
        }
        throw new Error(`SQL inesperado: ${sql}`);
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.respondPublic({
        body: { token: randomBytes(32).toString('base64url'), resposta: 'recusada' }
    }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /outra resposta registrada/);
    assert.equal(writes.some((sql) => /motivo_revogacao = 'resposta_anterior_preservada'/.test(sql)), true);
    assert.equal(connection.commit.mock.callCount(), 1);
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
        if (/FROM confirmacoes_consulta\s+WHERE clinica_id/.test(sql)) return [[]];
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

test('clique repetido mantém a solicitação pendente sem revogar ou gerar outro token', async (t) => {
    const writes = [];
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'secretaria' }]];
        if (/clinic\.nome AS clinica_nome/.test(sql)) return [[{
            id: 51, versao: 3, status: 'agendada', inicio_em: '2032-05-10 17:00:00.000',
            clinica_nome: 'Clínica Aurora', timezone: 'America/Sao_Paulo',
            telefone: '(43) 99999-8888', preferencia_contato: 'whatsapp', paciente_status: 'ativo'
        }]];
        if (/estado IN \('confirmada', 'recusada'\)/.test(sql)) return [[]];
        if (/FROM confirmacoes_consulta\s+WHERE clinica_id/.test(sql)) {
            return [[{ id: 91, canal: 'whatsapp', estado: 'preparada' }]];
        }
        writes.push(sql); throw new Error('nenhuma escrita deveria ocorrer');
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.requestConfirmation({
        userId: 7, tenant: { clinicId: 11, role: 'secretaria' },
        params: { id: '51' }, body: { versao: 3 }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.idempotente, true);
    assert.equal(res.body.whatsapp_url, null);
    assert.equal(writes.length, 0);
    assert.equal(connection.commit.mock.callCount(), 1);
});

test('reemissão explícita concorrente substitui somente o identificador observado pelas duas abas', async (t) => {
    let currentId = 91;
    let inserts = 0;
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'secretaria' }]];
        if (/clinic\.nome AS clinica_nome/.test(sql)) return [[{
            id: 51, versao: 3, status: 'agendada', inicio_em: '2032-05-10 17:00:00.000',
            clinica_nome: 'Clínica Aurora', timezone: 'America/Sao_Paulo',
            telefone: '43999998888', preferencia_contato: 'whatsapp', paciente_status: 'ativo'
        }]];
        if (/estado IN \('confirmada', 'recusada'\)/.test(sql)) return [[]];
        if (/CASE WHEN estado = 'preparada'/.test(sql)) {
            return [[{ id: currentId, canal: 'whatsapp', estado: 'preparada' }]];
        }
        if (/INSERT INTO confirmacoes_consulta \(/.test(sql)) {
            inserts += 1; currentId = 92; return [{ insertId: currentId }];
        }
        if (/confirmacoes_consulta_eventos|UPDATE confirmacoes_consulta|INSERT INTO auditoria/.test(sql)) {
            return [{ affectedRows: 1, insertId: 1 }];
        }
        throw new Error(`SQL inesperado: ${sql}`);
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const request = {
        userId: 7, tenant: { clinicId: 11, role: 'secretaria' }, params: { id: '51' },
        body: { versao: 3, substituir: true, confirmacao_id_esperada: 91 }
    };
    const first = response(); const second = response();
    await controller.requestConfirmation(request, first);
    await controller.requestConfirmation({ ...request, body: { ...request.body } }, second);
    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 200);
    assert.equal(second.body.idempotente, true);
    assert.equal(second.body.whatsapp_url, null);
    assert.equal(inserts, 1);
});

test('resposta definitiva bloqueia reemissão e direciona para correção administrativa', async (t) => {
    const connection = transaction(t, async (sql) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'administrador' }]];
        if (/clinic\.nome AS clinica_nome/.test(sql)) return [[{
            id: 51, versao: 3, status: 'agendada', inicio_em: '2032-05-10 17:00:00.000',
            clinica_nome: 'Clínica Aurora', timezone: 'America/Sao_Paulo',
            telefone: '43999998888', preferencia_contato: 'whatsapp', paciente_status: 'ativo'
        }]];
        if (/estado IN \('confirmada', 'recusada'\)/.test(sql)) {
            return [[{ id: 90, canal: 'manual', estado: 'confirmada' }]];
        }
        throw new Error('nenhuma reemissão deveria ocorrer');
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await controller.requestConfirmation({
        userId: 7, tenant: { clinicId: 11, role: 'administrador' }, params: { id: '51' },
        body: { versao: 3, substituir: true, confirmacao_id_esperada: 91 }
    }, res);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.error, /resposta definitiva/);
    assert.equal(connection.rollback.mock.callCount(), 1);
});

test('registro manual idêntico é idempotente e correção divergente exige ação explícita auditável', async (t) => {
    let correcting = false;
    const audits = [];
    const connection = transaction(t, async (sql, params) => {
        if (/SELECT cu\.papel/.test(sql)) return [[{ papel: 'administrador' }]];
        if (/SELECT id, versao, status, inicio_em FROM consultas/.test(sql)) return [[{
            id: 51, versao: 2, status: 'agendada', inicio_em: '2032-05-10 17:00:00.000'
        }]];
        if (/FROM confirmacoes_consulta\s+WHERE clinica_id/.test(sql)) {
            return [[{ id: 90, canal: 'manual', estado: 'confirmada' }]];
        }
        if (/INSERT INTO confirmacoes_consulta \(/.test(sql)) return [{ insertId: 93 }];
        if (/UPDATE confirmacoes_consulta/.test(sql)) return [{ affectedRows: 0 }];
        if (/INSERT INTO auditoria/.test(sql)) { audits.push(params); return [{ insertId: 1 }]; }
        if (/confirmacoes_consulta_eventos/.test(sql)) return [{ insertId: 1 }];
        throw new Error(`SQL inesperado: ${sql}`);
    });
    t.mock.method(pool, 'getConnection', async () => connection);
    const same = response();
    await controller.manualResponse({
        userId: 7, tenant: { clinicId: 11, role: 'administrador' }, params: { id: '51' },
        body: { versao: 2, resposta: 'confirmada' }
    }, same);
    assert.equal(same.statusCode, 200);
    assert.equal(same.body.idempotente, true);

    const conflict = response();
    await controller.manualResponse({
        userId: 7, tenant: { clinicId: 11, role: 'administrador' }, params: { id: '51' },
        body: { versao: 2, resposta: 'recusada' }
    }, conflict);
    assert.equal(conflict.statusCode, 409);

    correcting = true;
    const corrected = response();
    await controller.manualResponse({
        userId: 7, tenant: { clinicId: 11, role: 'administrador' }, params: { id: '51' },
        body: { versao: 2, resposta: 'recusada', corrigir: correcting }
    }, corrected);
    assert.equal(corrected.statusCode, 201);
    assert.equal(audits.length, 1);
    assert.equal(audits[0][2], 'confirmacao_corrigida_manual');
    assert.match(audits[0][4], /corrige_confirmacao_id/);
});

test('consulta pública só revela clínica e horário enquanto o link estiver ativo', async (t) => {
    const active = {
        estado: 'preparada', expira_em: new Date(Date.now() + 3600000), consulta_versao: 2,
        versao: 2, status: 'agendada', inicio_em: '2032-05-10 17:00:00.000',
        clinica_nome: 'Clínica Aurora', timezone: 'America/Sao_Paulo',
        telefone: '43999998888', preferencia_contato: 'whatsapp', paciente_status: 'ativo'
    };
    t.mock.method(pool, 'execute', async () => [[active]]);
    const token = randomBytes(32).toString('base64url');
    const ok = response();
    await controller.inspectPublic({ body: { token } }, ok);
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(Object.keys(ok.body).sort(), ['clinica_nome', 'inicio_local', 'pode_responder']);

    pool.execute.mock.mockImplementation(async () => [[{ ...active, estado: 'revogada' }]]);
    const revoked = response();
    await controller.inspectPublic({ body: { token } }, revoked);
    assert.equal(revoked.statusCode, 404);
    assert.deepEqual(revoked.body, { error: 'Este link não está disponível.' });
});

test('operações públicas recusam paciente inativo, sem preferência ou com telefone alterado inválido', async (t) => {
    const token = randomBytes(32).toString('base64url');
    const invalidPatients = [
        { telefone: '43999998888', preferencia_contato: 'whatsapp', paciente_status: 'inativo' },
        { telefone: '43999998888', preferencia_contato: 'nenhum', paciente_status: 'ativo' },
        { telefone: '00000000000', preferencia_contato: 'whatsapp', paciente_status: 'ativo' }
    ];
    for (const invalid of invalidPatients) {
        t.mock.method(pool, 'execute', async () => [[{
            estado: 'preparada', expira_em: new Date(Date.now() + 3600000), consulta_versao: 2,
            versao: 2, status: 'agendada', inicio_em: '2032-05-10 17:00:00.000',
            clinica_nome: 'Clínica Aurora', timezone: 'America/Sao_Paulo', ...invalid
        }]]);
        const inspected = response();
        await controller.inspectPublic({ body: { token } }, inspected);
        assert.equal(inspected.statusCode, 404);
        t.mock.restoreAll();

        const connection = transaction(t, async (sql) => {
            if (/SELECT cc\.clinica_id, cc\.consulta_id/.test(sql)) {
                return [[{ clinica_id: 11, consulta_id: 51, paciente_id: 31 }]];
            }
            if (/FROM pacientes WHERE/.test(sql)) return [[{
                id: 31, telefone: invalid.telefone,
                preferencia_contato: invalid.preferencia_contato,
                status: invalid.paciente_status
            }]];
            if (/SELECT id FROM consultas/.test(sql)) return [[{ id: 51 }]];
            if (/WHERE cc\.token_hash = \? LIMIT 1 FOR UPDATE/.test(sql)) return [[{
                id: 91, clinica_id: 11, consulta_id: 51, consulta_versao: 2,
                estado: 'preparada', expira_em: new Date(Date.now() + 3600000), versao: 2,
                status: 'agendada', inicio_em: '2032-05-10 17:00:00.000'
            }]];
            throw new Error('nenhuma escrita deveria ocorrer');
        });
        t.mock.method(pool, 'getConnection', async () => connection);
        const responded = response();
        await controller.respondPublic({ body: { token, resposta: 'confirmada' } }, responded);
        assert.equal(responded.statusCode, 409);
        assert.equal(connection.execute.mock.calls.some((call) =>
            /UPDATE confirmacoes_consulta/.test(call.arguments[0])), false);
        t.mock.restoreAll();
    }
});

test('rotas públicas recebem token no corpo e aplicam proteção contra cache, referência e indexação', () => {
    assert.equal(router.stack.some((layer) =>
        String(layer.route?.path || '').startsWith('/confirmacoes-consulta/:token')), false);
    for (const routePath of ['/confirmacoes-consulta/consultar', '/confirmacoes-consulta/responder']) {
        const route = router.stack.find((layer) => layer.route?.path === routePath && layer.route.methods.post);
        assert.ok(route);
        const headers = {};
        let next = false;
        route.route.stack[1].handle({}, { set(values) { Object.assign(headers, values); } }, () => { next = true; });
        assert.equal(next, true);
        assert.match(headers['Cache-Control'], /no-store/);
        assert.equal(headers['Referrer-Policy'], 'no-referrer');
        assert.match(headers['X-Robots-Tag'], /noindex/);
    }
});

test('telefone exige formato E.164 ou numeração brasileira plausível', () => {
    assert.equal(controller.whatsappNumber('(43) 99999-8888'), '5543999998888');
    assert.equal(controller.whatsappNumber('+55 43 99999-8888'), '5543999998888');
    assert.equal(controller.whatsappNumber('00000000000'), null);
    assert.equal(controller.whatsappNumber('4311111111'), null);
    assert.equal(controller.whatsappNumber('+0123456789'), null);
});

test('origem pública exige HTTPS fora do ambiente local', () => {
    const configPath = path.join(__dirname, '..', 'config', 'environment.js');
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(configPath)})`], {
        encoding: 'utf8',
        env: {
            ...process.env, APP_PUBLIC_ORIGIN: 'http://vitalis.example',
            DB_HOST: '127.0.0.1', DB_USER: 'fixture', DB_PASSWORD: 'fixture',
            DB_DATABASE: 'fixture', JWT_SECRET: randomBytes(32).toString('hex')
        }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HTTPS fora do ambiente local/);
});

test('agenda e calendário ignoram confirmações de versões anteriores após reagendamento', async () => {
    const [consultations, confirmations] = await Promise.all([
        fs.readFile(path.join(__dirname, '..', 'controllers', 'consultaController.js'), 'utf8'),
        fs.readFile(path.join(__dirname, '..', 'controllers', 'confirmacaoConsultaController.js'), 'utf8')
    ]);
    assert.equal((consultations.match(/cc\.consulta_versao = c\.versao/g) || []).length, 6);
    assert.equal((consultations.match(/estado IN \('confirmada', 'recusada'\)\) DESC/g) || []).length, 4);
    assert.match(consultations, /revokePrepared[\s\S]*consulta_reagendada/);
    assert.match(confirmations, /exports\.history[\s\S]*confirmacoes: rows/);
});

test('solicitação revalida preferência, paciente, profissional e vínculos ativos', async () => {
    const source = await fs.readFile(path.join(
        __dirname, '..', 'controllers', 'confirmacaoConsultaController.js'
    ), 'utf8');
    assert.match(source, /pa\.preferencia_contato/);
    assert.match(source, /p\.status = 'ativo'/);
    assert.match(source, /pcu\.status = 'ativo' AND pu\.status = 'ativo'/);
    assert.match(source, /pacu\.status = 'ativo' AND pau\.status = 'ativo'/);
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
    assert.match(page, /name="referrer" content="no-referrer"/);
    assert.match(page, /name="robots" content="noindex, nofollow, noarchive"/);
    assert.doesNotMatch(page, /confirmation-professional|confirmation-specialty/);
    assert.match(controllerSource, /Abrir o WhatsApp não comprova envio nem entrega/);
    assert.match(controllerSource, /#token=/);
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
