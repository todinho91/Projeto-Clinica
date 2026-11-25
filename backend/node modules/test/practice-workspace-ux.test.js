const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

Object.assign(process.env, {
    DB_HOST: '127.0.0.1',
    DB_USER: 'fixture_user',
    DB_PASSWORD: 'fixture_password',
    DB_DATABASE: 'fixture_database',
    JWT_SECRET: randomBytes(32).toString('hex'),
    MAIL_PROVIDER: 'disabled',
    APP_PUBLIC_ORIGIN: 'http://127.0.0.1:5500'
});

const root = path.join(__dirname, '..', '..', '..');
const core = require('../../../js/vitalis-client');
const pool = require('../config/database');
const teamController = require('../controllers/equipeController');
const patientController = require('../controllers/pacienteController');
const availabilityManager = require('../middleware/availabilityManager');
const clinicalDocumentAccess = require('../middleware/clinicalDocumentAccess');
const router = require('../routes');

function response() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function transactionalConnection(execute) {
    return {
        execute,
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release() {}
    };
}

test('menu do titular é único, completo e derivado das capacidades do consultório', () => {
    const owner = {
        id: 21, papel: 'profissional', tipo_contexto: 'consultorio', titular: true
    };
    const items = core.workspaceNavigation(owner);
    assert.deepEqual(items.map((item) => item.href), [
        'consultorio.html', 'dashboard-medico.html', 'pacientes.html',
        'especialidades.html', 'disponibilidade.html', 'agenda.html',
        'calendario.html', 'equipe.html', 'configuracoes-clinica.html'
    ]);
    assert.equal(items.some((item) => item.href === 'profissionais.html'), false);
    for (const page of items.map((item) => item.href)) {
        assert.equal(core.roleCanAccessPage('profissional', page, owner), true, page);
    }
});

test('secretária do consultório recebe somente capacidades administrativas delegadas', () => {
    const secretary = {
        id: 21, papel: 'secretaria', tipo_contexto: 'consultorio', titular: false,
        permissoes: { gerenciar_disponibilidade: false }
    };
    assert.deepEqual(core.workspaceNavigation(secretary).map((item) => item.href), [
        'dashboard-secretaria.html', 'pacientes.html', 'agenda.html', 'calendario.html'
    ]);
    assert.equal(core.roleCanAccessPage('secretaria', 'disponibilidade.html', secretary), false);
    assert.equal(core.roleCanAccessPage('secretaria', 'equipe.html', secretary), false);
    assert.equal(core.roleCanAccessPage('secretaria', 'especialidades.html', secretary), false);

    const delegated = {
        ...secretary, permissoes: { gerenciar_disponibilidade: true }
    };
    assert.equal(core.roleCanAccessPage('secretaria', 'disponibilidade.html', delegated), true);
    assert.ok(core.workspaceNavigation(delegated)
        .some((item) => item.href === 'disponibilidade.html'));
});

test('clínica institucional preserva menus por papel sem herdar poderes do titular', () => {
    const admin = { papel: 'administrador', tipo_contexto: 'clinica', titular: false };
    const secretary = { papel: 'secretaria', tipo_contexto: 'clinica', titular: false };
    const professional = { papel: 'profissional', tipo_contexto: 'clinica', titular: false };
    assert.ok(core.workspaceNavigation(admin).some((item) => item.href === 'configuracoes-clinica.html'));
    assert.equal(core.workspaceNavigation(secretary)
        .some((item) => item.href === 'configuracoes-clinica.html'), false);
    assert.equal(core.roleCanAccessPage('profissional', 'pacientes.html', professional), false);
    assert.equal(core.roleCanAccessPage('profissional', 'equipe.html', professional), false);
});

test('alterar disponibilidade exige delegação explícita no consultório', () => {
    const allowed = [];
    availabilityManager({ tenant: {
        isPractice: true, isPracticeOwner: true, role: 'profissional', permissions: {}
    } }, response(), () => allowed.push('owner'));
    availabilityManager({ tenant: {
        isPractice: true, isPracticeOwner: false, role: 'secretaria',
        permissions: { manageAvailability: true }
    } }, response(), () => allowed.push('secretary'));
    const denied = response();
    availabilityManager({ tenant: {
        isPractice: true, isPracticeOwner: false, role: 'secretaria',
        permissions: { manageAvailability: false }
    } }, denied, () => allowed.push('unexpected'));
    const institutional = response();
    availabilityManager({ tenant: {
        isPractice: false, role: 'secretaria', permissions: {}
    } }, institutional, () => allowed.push('institutional'));
    assert.deepEqual(allowed, ['owner', 'secretary', 'institutional']);
    assert.equal(denied.statusCode, 403);
});

test('secretária do consultório não alcança upload clínico antes do processamento do arquivo', () => {
    const denied = response();
    clinicalDocumentAccess({ tenant: {
        isPractice: true, isPracticeOwner: false, role: 'secretaria'
    } }, denied, () => assert.fail('não deveria liberar documento clínico'));
    assert.equal(denied.statusCode, 403);

    for (const tenant of [
        { isPractice: true, isPracticeOwner: true, role: 'profissional' },
        { isPractice: false, role: 'secretaria' }
    ]) {
        let called = false;
        clinicalDocumentAccess({ tenant }, response(), () => { called = true; });
        assert.equal(called, true);
    }
    const upload = router.stack.find((layer) => layer.route?.path === '/documentos/upload');
    const handlers = upload.route.stack.map((layer) => layer.handle.name);
    assert.ok(handlers.indexOf('clinicalDocumentAccess') < handlers.indexOf('multerMiddleware'));
});

test('secretária do consultório não recebe documentos nos detalhes administrativos', async (t) => {
    const executions = [];
    t.mock.method(pool, 'execute', async (sql) => {
        executions.push(sql);
        if (/FROM pacientes p/.test(sql)) {
            return [[{ id: 44, nome: 'Paciente de teste', status: 'ativo' }]];
        }
        if (/FROM consultas c/.test(sql)) return [[]];
        if (/FROM documentos_clinicos/.test(sql)) {
            assert.fail('a consulta de documentos não deve ser executada para a secretária');
        }
        return [[]];
    });
    const res = response();
    await patientController.getPacienteDetails({
        userId: 9,
        tenant: {
            clinicId: 11, role: 'secretaria', isPractice: true, isPracticeOwner: false
        },
        params: { id: '44' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.documentos, []);
    assert.equal(executions.some((sql) => /FROM documentos_clinicos/.test(sql)), false);
});

test('titular delega disponibilidade em transação, audita e revoga a sessão anterior', async (t) => {
    const executions = [];
    const connection = transactionalConnection(async (sql, params) => {
        executions.push({ sql, params });
        if (/cu\.papel = \?[\s\S]*FOR UPDATE/.test(sql)) {
            return [[{
                papel: 'profissional', vinculo_status: 'ativo', usuario_status: 'ativo',
                clinica_status: 'ativa', consultorio_id: 11, consultorio_titular: 1
            }]];
        }
        if (/SELECT cu\.id, cu\.papel, cu\.status/.test(sql)) {
            return [[{
                id: 80, papel: 'secretaria', status: 'ativo', gerenciar_disponibilidade: 0
            }]];
        }
        return [{ affectedRows: 1 }];
    });
    const commit = t.mock.method(connection, 'commit');
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await teamController.updatePermissions({
        userId: 7,
        auth: { membershipVersion: 4 },
        tenant: { clinicId: 11, role: 'profissional', isPractice: true },
        params: { id: '80' },
        body: { gerenciar_disponibilidade: true }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(commit.mock.callCount(), 1);
    assert.ok(executions.some(({ sql, params }) => (
        /INSERT INTO consultorio_delegacoes/.test(sql)
        && params[0] === 11 && params[1] === 80 && params[2] === 1 && params[3] === 7
    )));
    assert.ok(executions.some(({ sql, params }) => (
        /sessao_versao = sessao_versao \+ 1/.test(sql)
        && params[0] === 80 && params[1] === 11
    )));
    const audit = executions.find(({ sql }) => /INSERT INTO auditoria/.test(sql));
    assert.ok(audit);
    assert.ok(audit.params.includes('delegacao_consultorio_alterada'));
    assert.match(audit.params.at(-1), /"gerenciar_disponibilidade_anterior":false/);
    assert.match(audit.params.at(-1), /"gerenciar_disponibilidade":true/);
});

test('delegação recusa vínculo pendente, inativo ou pertencente a outro tenant', async (t) => {
    for (const target of [
        { id: 80, papel: 'secretaria', status: 'inativo', gerenciar_disponibilidade: 0 },
        { id: 80, papel: 'secretaria', status: 'convite_pendente', gerenciar_disponibilidade: 0 },
        null
    ]) {
        const executions = [];
        const connection = transactionalConnection(async (sql, params) => {
            executions.push({ sql, params });
            if (/cu\.papel = \?[\s\S]*FOR UPDATE/.test(sql)) {
                return [[{
                    papel: 'profissional', vinculo_status: 'ativo', usuario_status: 'ativo',
                    clinica_status: 'ativa', consultorio_id: 11, consultorio_titular: 1
                }]];
            }
            if (/SELECT cu\.id, cu\.papel, cu\.status/.test(sql)) {
                return [target ? [target] : []];
            }
            return [{ affectedRows: 1 }];
        });
        const rollback = t.mock.method(connection, 'rollback');
        t.mock.method(pool, 'getConnection', async () => connection);
        const res = response();
        await teamController.updatePermissions({
            userId: 7,
            auth: { membershipVersion: 4 },
            tenant: { clinicId: 11, role: 'profissional', isPractice: true },
            params: { id: '80' },
            body: { gerenciar_disponibilidade: true }
        }, res);
        assert.equal(res.statusCode, target ? 409 : 404);
        assert.equal(rollback.mock.callCount(), 1);
        assert.equal(executions.some(({ sql }) => /INSERT INTO consultorio_delegacoes/.test(sql)), false);
        t.mock.reset();
    }
});

test('arquivamento de paciente preserva histórico, revoga links pendentes e audita', async (t) => {
    const executions = [];
    const connection = transactionalConnection(async (sql, params) => {
        executions.push({ sql, params });
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id[\s\S]*FROM clinica_usuarios/.test(sql)) return [[{ id: 70 }]];
        if (/SELECT id, status[\s\S]*FROM pacientes/.test(sql)) {
            return [[{ id: 44, status: 'ativo' }]];
        }
        if (/UPDATE confirmacoes_consulta cc/.test(sql)) return [{ affectedRows: 2 }];
        return [{ affectedRows: 1 }];
    });
    const commit = t.mock.method(connection, 'commit');
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await patientController.updatePatientStatus({
        userId: 7,
        auth: { membershipVersion: 4 },
        tenant: { clinicId: 11, role: 'secretaria' },
        params: { id: '44' },
        body: { status: 'inativo' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(commit.mock.callCount(), 1);
    assert.ok(executions.some(({ sql, params }) => (
        /UPDATE pacientes SET status = \?/.test(sql)
        && params[0] === 'inativo' && params[1] === 11 && params[2] === 44
    )));
    assert.ok(executions.some(({ sql }) => /UPDATE confirmacoes_consulta cc/.test(sql)));
    assert.ok(executions.some(({ sql, params }) => (
        /INSERT INTO auditoria/.test(sql) && params.includes('paciente_arquivado')
    )));
    assert.equal(executions.some(({ sql }) => /DELETE\s+FROM\s+pacientes/i.test(sql)), false);
});

test('ID de paciente de outro tenant não pode ser arquivado nem reativado', async (t) => {
    const executions = [];
    const connection = transactionalConnection(async (sql, params) => {
        executions.push({ sql, params });
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id[\s\S]*FROM clinica_usuarios/.test(sql)) return [[{ id: 70 }]];
        if (/SELECT id, status[\s\S]*FROM pacientes/.test(sql)) return [[]];
        return [{ affectedRows: 1 }];
    });
    const rollback = t.mock.method(connection, 'rollback');
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await patientController.updatePatientStatus({
        userId: 7,
        auth: { membershipVersion: 4 },
        tenant: { clinicId: 11, role: 'secretaria' },
        params: { id: '999' },
        body: { status: 'inativo' }
    }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(rollback.mock.callCount(), 1);
    assert.equal(executions.some(({ sql }) => /UPDATE pacientes/.test(sql)), false);
});

test('interface usa navegação central, arquivamento lógico e não expõe referências internas', async () => {
    const pageNames = [
        'agenda.html', 'calendario.html', 'configuracoes-clinica.html', 'consultorio.html',
        'dashboard-medico.html', 'dashboard-secretaria.html', 'disponibilidade.html',
        'equipe.html', 'especialidades.html', 'pacientes.html', 'profissionais.html'
    ];
    const contents = await Promise.all(pageNames.map((name) => (
        fs.readFile(path.join(root, name), 'utf8')
    )));
    const main = await fs.readFile(path.join(root, 'js', 'main.js'), 'utf8');
    const css = await fs.readFile(path.join(root, 'css', 'dashboard.css'), 'utf8');
    for (let index = 0; index < pageNames.length; index += 1) {
        assert.match(contents[index], /class="vitalis-nav"/, pageNames[index]);
        assert.match(contents[index], /js\/vitalis-client\.js/, pageNames[index]);
        assert.match(contents[index], /js\/main\.js/, pageNames[index]);
    }
    assert.match(main, /function renderWorkspaceNavigation/);
    assert.match(main, /navigation\.dataset\.ready = 'true'/);
    assert.match(css, /\.vitalis-nav[^}]*overflow-y:\s*auto/);
    assert.match(css, /\.vitalis-nav:not\(\[data-ready="true"\]\)[^}]*visibility:\s*hidden/);
    assert.match(main, /\/pacientes\/\$\{patient\.id\}\/status/);
    assert.match(main, /Arquivar[\s\S]*históricos serão preservados/);
    assert.doesNotMatch(contents.join('\n'), /data-(?:management|professional)-only/);
    assert.doesNotMatch(`${contents.join('\n')}\n${main}`, /\bPR\s*#|\bmilestone\b|\bissue\s*#|\bM[0-9]+\s*[—–-]/i);
});
