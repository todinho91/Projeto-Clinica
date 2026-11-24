const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');

Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_USER: 'fixture_user', DB_PASSWORD: 'fixture_password',
    DB_DATABASE: 'fixture_database', PORT: '3000', JWT_SECRET: randomBytes(32).toString('hex'),
    PATIENT_CPF_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PATIENT_CPF_INDEX_KEY: randomBytes(32).toString('base64'),
    PATIENT_CPF_KEY_ID: 'test-key-v1'
});

const pool = require('../config/database');
const cepService = require('../services/cep-service');
const controller = require('../controllers/pacienteController');
const router = require('../routes');

function response() {
    return { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

function connection(execute) {
    return { execute, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
}

function request(overrides = {}) {
    const body = {
        clinica_id: 999, nome: '  Maria   Silva  ', email: 'MARIA@example.test',
        telefone: '(41) 99999-1234', data_nascimento: '1990-05-20', status: 'ativo',
        cpf: '529.982.247-25', cep: '86300-000', logradouro: 'Rua de Teste',
        numero: '100', complemento: '', bairro: 'Centro', cidade: 'Cornélio Procópio', uf: 'PR',
        ...overrides.body
    };
    return {
        userId: 7, tenant: { clinicId: 11, role: 'secretaria' }, ...overrides, body
    };
}

test('validação normaliza dados e recusa datas inválidas ou futuras', () => {
    assert.deepEqual(controller.patientPayload(request().body), {
        name: 'Maria Silva', email: 'maria@example.test', phone: '41999991234',
        birthDate: '1990-05-20', status: 'ativo', contactPreference: 'nenhum'
    });
    assert.equal(controller.patientPayload({ nome: 'Maria', data_nascimento: '2999-01-01' }), null);
    assert.equal(controller.patientPayload({ nome: 'Maria', email: 'invalido' }), null);
});

test('listagem é isolada e mascara dados pessoais', async (t) => {
    const calls = [];
    t.mock.method(pool, 'execute', async (sql, params) => {
        calls.push({ sql, params });
        if (/COUNT/.test(sql)) return [[{ total: 1 }]];
        return [[{
            id: 3, nome: 'Maria', email: 'maria@example.test', telefone: '41999991234',
            ano_nascimento: 1990, status: 'ativo', cadastro_status: 'pendente'
        }]];
    });
    const res = response();
    await controller.listForManagement({ tenant: { clinicId: 11 }, query: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.pacientes[0].email_mascarado, 'm***@example.test');
    assert.equal(res.body.pacientes[0].telefone_mascarado, '***1234');
    assert.equal(res.body.pacientes[0].cadastro_status, 'pendente');
    assert.equal('email' in res.body.pacientes[0], false);
    assert.ok(calls.every((call) => call.params[0] === 11 && /clinica_id = \?/.test(call.sql)));
});

test('paginação recusa valores fora dos limites antes de consultar o banco', async (t) => {
    const execute = t.mock.method(pool, 'execute', async () => {
        throw new Error('não deveria consultar o banco');
    });
    for (const query of [
        { pagina: '0' }, { pagina: '-1' }, { pagina: '1.5' },
        { pagina: '100001' }, { limite: '0' }, { limite: '51' }, { limite: 'abc' }
    ]) {
        const res = response();
        await controller.listForManagement({ tenant: { clinicId: 11 }, query }, res);
        assert.equal(res.statusCode, 400);
    }
    assert.equal(execute.mock.callCount(), 0);
});

test('paginação aceita os limites máximos sem interpolar entrada livre', async (t) => {
    const sqlSeen = [];
    t.mock.method(pool, 'execute', async (sql) => {
        sqlSeen.push(sql);
        return /COUNT/.test(sql) ? [[{ total: 0 }]] : [[]];
    });
    const res = response();
    await controller.listForManagement({
        tenant: { clinicId: 11 }, query: { pagina: '100000', limite: '50' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.match(sqlSeen[0], /LIMIT 50 OFFSET 4999950/);
});

test('busca para M4-02 expõe somente id, nome e ano na clínica ativa', async (t) => {
    t.mock.method(pool, 'execute', async (sql, params) => {
        assert.match(sql, /clinica_id = \? AND status = 'ativo'/);
        assert.equal(params[0], 11);
        return [[{ id: 3, nome: 'Maria', ano_nascimento: 1990 }]];
    });
    const res = response();
    await controller.searchForScheduling({ tenant: { clinicId: 11 }, query: { q: 'Mar' } }, res);
    assert.deepEqual(res.body, [{ id: 3, nome: 'Maria', ano_nascimento: 1990 }]);
});

test('secretaria cadastra no tenant autenticado sem criar identidade global', async (t) => {
    const executions = [];
    const db = connection(async (sql, params) => {
        executions.push({ sql, params });
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id/.test(sql)) return [[{ id: 2 }]];
        if (/FROM pacientes p/.test(sql)) return [[]];
        if (/INSERT INTO pacientes/.test(sql)) return [{ insertId: 44 }];
        return [{ affectedRows: 1 }];
    });
    const commit = t.mock.method(db, 'commit');
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.createPatient(request(), res);
    assert.equal(res.statusCode, 201);
    assert.equal(commit.mock.callCount(), 1);
    const insert = executions.find((entry) => /INSERT INTO pacientes/.test(entry.sql));
    assert.match(insert.sql, /VALUES \(\?, NULL/);
    assert.equal(insert.params[0], 11);
    assert.equal(executions.some((entry) => entry.params?.includes(999)), false);
    const identification = executions.find((entry) => /INSERT INTO pacientes_identificacao/.test(entry.sql));
    assert.ok(Buffer.isBuffer(identification.params[3]));
    assert.equal(identification.params.includes('52998224725'), false);
    const audit = executions.find((entry) => /INSERT INTO auditoria/.test(entry.sql));
    assert.equal(audit.params.join(' ').includes('maria@example.test'), false);
});

test('duplicidade na clínica aborta sem inserir', async (t) => {
    const executions = [];
    const db = connection(async (sql) => {
        executions.push(sql);
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id/.test(sql)) return [[{ id: 2 }]];
        if (/FROM pacientes p/.test(sql)) return [[{
            id: 5, nome: 'Maria Silva', email: 'maria@example.test',
            telefone: '41999991234', data_nascimento: '1990-05-20', status: 'ativo'
        }]];
        return [{ affectedRows: 1 }];
    });
    const rollback = t.mock.method(db, 'rollback');
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.createPatient(request(), res);
    assert.equal(res.statusCode, 409);
    assert.equal(rollback.mock.callCount(), 1);
    assert.equal(executions.some((sql) => /INSERT INTO pacientes/.test(sql)), false);
});

test('nome canônico trata espaços, caixa e acentuação sem fundir prontuários', () => {
    assert.equal(controller.canonicalName('  João   da SILVA '), 'joao da silva');
    const candidates = [{ id: 5, bloqueante: false, nome: 'Maria Silva' }];
    assert.equal(controller.duplicateResult(candidates, null).blocked, true);
    assert.equal(controller.duplicateResult(candidates, 'homonimo_confirmado').blocked, false);
    assert.equal(controller.duplicateResult([{ ...candidates[0], bloqueante: true }], 'dados_conferidos').blocked, true);
    const many = Array.from({ length: 12 }, (_, index) => ({
        id: index + 1, nome: `Candidato ${index + 1}`, bloqueante: index === 11
    }));
    const result = controller.duplicateResult(many, 'dados_conferidos');
    assert.equal(result.blocked, true, 'candidato bloqueante após o décimo não pode ser ignorado');
    assert.equal(result.total, 12);
    assert.equal(result.candidates.length, 10, 'somente a exibição é limitada');
});

test('telefone formatado é normalizado antes da detecção', () => {
    const payload = controller.patientPayload({
        nome: 'Contato Familiar', telefone: '(41) 99999-1234', status: 'ativo'
    });
    assert.equal(payload.phone, '41999991234');
});

test('cadastro rotineiro incompleto é bloqueado antes de consultar o banco', async (t) => {
    const getConnection = t.mock.method(pool, 'getConnection', async () => {
        throw new Error('não deveria consultar o banco');
    });
    const res = response();
    await controller.createPatient(request({ body: {
        nome: 'João da Silva', data_nascimento: '', cep: '', logradouro: '', numero: ''
    } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(getConnection.mock.callCount(), 0);
});

test('exceção controlada permite atendimento sem CPF ou endereço fictício', async (t) => {
    const executions = [];
    const db = connection(async (sql, params) => {
        executions.push({ sql, params });
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id/.test(sql)) return [[{ id: 2 }]];
        if (/FROM pacientes p/.test(sql)) return [[]];
        if (/INSERT INTO pacientes \(/.test(sql)) return [{ insertId: 46 }];
        return [{ affectedRows: 1 }];
    });
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.createPatient(request({ body: {
        nome: 'Paciente sem documento', cpf: '', cpf_excecao: 'nao_possui',
        cep: '', logradouro: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '',
        endereco_excecao: 'sem_endereco_convencional'
    } }), res);
    assert.equal(res.statusCode, 201);
    const identification = executions.find((entry) => /INSERT INTO pacientes_identificacao/.test(entry.sql));
    assert.equal(identification.params[2], 'excecao');
    assert.equal(identification.params[9], 'nao_possui');
    assert.equal(identification.params[17], 'sem_endereco_convencional');
    const audit = executions.find((entry) => /INSERT INTO auditoria/.test(entry.sql));
    assert.match(audit.params.at(-1), /"cadastro_status":"excecao"/);
    assert.doesNotMatch(audit.params.at(-1), /52998224725/);
});

test('paciente histórico pode ser editado sem perder vínculos e permanece pendente', async (t) => {
    const executions = [];
    const db = connection(async (sql, params) => {
        executions.push({ sql, params });
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id/.test(sql)) return [[{ id: 2 }]];
        if (/identificacao_paciente_id/.test(sql) && /FOR UPDATE/.test(sql)) return [[{
            id: 77, usuario_id: null, nome: 'Paciente Histórico', email: null,
            telefone: null, preferencia_contato: 'nenhum', data_nascimento: null,
            status: 'ativo', cadastro_status: 'pendente', identificacao_paciente_id: null
        }]];
        if (/FROM pacientes p/.test(sql)) return [[]];
        return [{ affectedRows: 1 }];
    });
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.updatePatient(request({
        params: { id: '77' },
        body: {
            nome: 'Paciente Histórico', email: 'historico@example.test', telefone: '',
            data_nascimento: '', cpf: '', cep: '', logradouro: '', numero: '',
            complemento: '', bairro: '', cidade: '', uf: '',
            manter_cadastro_pendente: true
        }
    }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(executions.some((entry) => /INSERT INTO pacientes_identificacao/.test(entry.sql)), false);
    const audit = executions.find((entry) => /INSERT INTO auditoria/.test(entry.sql));
    assert.match(audit.params.at(-1), /"cadastro_status":"pendente"/);
});

test('homônimo com dados distintos exige revisão explícita e auditada', async (t) => {
    const executions = [];
    const db = connection(async (sql, params) => {
        executions.push({ sql, params });
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id/.test(sql)) return [[{ id: 2 }]];
        if (/FROM pacientes p/.test(sql)) return [[{
            id: 5, nome: 'Maria Silva', email: null, telefone: null,
            data_nascimento: '1980-01-10', status: 'ativo'
        }]];
        if (/INSERT INTO pacientes/.test(sql)) return [{ insertId: 45 }];
        if (/INSERT INTO auditoria/.test(sql)) return [{ insertId: 1 }];
        throw new Error(`SQL inesperado: ${sql}`);
    });
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.createPatient(request({ body: {
        nome: 'Maria Silva', email: '', telefone: '', data_nascimento: '1990-05-20',
        status: 'ativo', revisao_duplicidade: true, motivo_revisao: 'homonimo_confirmado'
    } }), res);
    assert.equal(res.statusCode, 201);
    const audit = executions.find((entry) => /INSERT INTO auditoria/.test(entry.sql));
    assert.match(audit.params.at(-1), /"revisao_duplicidade":true/);
    assert.match(audit.params.at(-1), /"motivo_revisao":"homonimo_confirmado"/);
});

test('pré-verificação expõe somente candidatos mascarados da clínica ativa', async (t) => {
    const db = connection(async (sql, params) => {
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id/.test(sql)) return [[{ id: 2 }]];
        if (/FROM pacientes p/.test(sql)) {
            assert.equal(params[0], 11);
            return [[{
                id: 5, nome: 'Maria Silva', email: 'maria@example.test',
                telefone: '41999991234', data_nascimento: '1990-05-20', status: 'ativo'
            }]];
        }
        throw new Error(`SQL inesperado: ${sql}`);
    });
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.previewDuplicates(request(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.possui_candidatos, true);
    assert.equal(res.body.candidatos[0].email_mascarado, 'm***@example.test');
    assert.equal(res.body.candidatos[0].telefone_mascarado, '***1234');
    assert.equal('email' in res.body.candidatos[0], false);
    assert.equal('telefone' in res.body.candidatos[0], false);
});

test('permissão do operador é revalidada dentro da transação', async (t) => {
    const executions = [];
    const db = connection(async (sql) => {
        executions.push(sql);
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id/.test(sql)) return [[]];
        return [{ affectedRows: 1 }];
    });
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.createPatient(request(), res);
    assert.equal(res.statusCode, 403);
    assert.equal(executions.some((sql) => /INSERT INTO pacientes/.test(sql)), false);
});

test('edição por identificador de outra clínica retorna 404', async (t) => {
    const db = connection(async (sql) => {
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id/.test(sql)) return [[{ id: 2 }]];
        if (/FROM pacientes p/.test(sql)) return [[]];
        return [{ affectedRows: 1 }];
    });
    t.mock.method(pool, 'getConnection', async () => db);
    const res = response();
    await controller.updatePatient(request({ params: { id: '77' } }), res);
    assert.equal(res.statusCode, 404);
});

test('alteração de telefone, preferência ou inativação revoga links pendentes na mesma transação', async (t) => {
    for (const change of [
        { telefone: '(43) 98888-7777', preferencia_contato: 'whatsapp', status: 'ativo' },
        { telefone: '(43) 99999-1234', preferencia_contato: 'nenhum', status: 'ativo' },
        { telefone: '(43) 99999-1234', preferencia_contato: 'whatsapp', status: 'inativo' }
    ]) {
        const executions = [];
        const db = connection(async (sql, params) => {
            executions.push({ sql, params });
            if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
            if (/SELECT cu\.id/.test(sql)) return [[{ id: 2 }]];
            if (/FROM pacientes p/.test(sql) && /FOR UPDATE/.test(sql)
                && /identificacao_paciente_id/.test(sql)) return [[{
                id: 77, usuario_id: null, nome: 'Maria Silva', email: 'maria@example.test',
                telefone: '43999991234', preferencia_contato: 'whatsapp',
                data_nascimento: '1990-05-20', status: 'ativo', cadastro_status: 'pendente'
            }]];
            if (/FROM pacientes p/.test(sql)) return [[]];
            if (/UPDATE confirmacoes_consulta cc/.test(sql)) return [{ affectedRows: 2 }];
            return [{ affectedRows: 1, insertId: 1 }];
        });
        const commit = t.mock.method(db, 'commit');
        t.mock.method(pool, 'getConnection', async () => db);
        const res = response();
        await controller.updatePatient(request({
            params: { id: '77' },
            body: { ...request().body, ...change }
        }), res);
        assert.equal(res.statusCode, 200);
        assert.equal(commit.mock.callCount(), 1);
        assert.equal(executions.some((entry) => /INSERT INTO confirmacoes_consulta_eventos/.test(entry.sql)), true);
        const revoked = executions.find((entry) => /UPDATE confirmacoes_consulta cc/.test(entry.sql));
        assert.deepEqual(revoked.params.slice(-2), [11, 77]);
        const auditEntry = executions.find((entry) => /INSERT INTO auditoria/.test(entry.sql));
        assert.match(auditEntry.params.at(-1), /"confirmacoes_revogadas":2/);
        t.mock.restoreAll();
    }
});

test('falha parcial provoca rollback e não confirma a transação', async (t) => {
    const db = connection(async (sql) => {
        if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 11 }]];
        if (/SELECT cu\.id/.test(sql)) return [[{ id: 2 }]];
        if (/FROM pacientes p/.test(sql)) return [[]];
        if (/INSERT INTO pacientes/.test(sql)) return [{ insertId: 44 }];
        throw new Error('falha de auditoria');
    });
    const rollback = t.mock.method(db, 'rollback');
    const commit = t.mock.method(db, 'commit');
    t.mock.method(pool, 'getConnection', async () => db);
    t.mock.method(console, 'error', () => {});
    const res = response();
    await controller.createPatient(request(), res);
    assert.equal(res.statusCode, 500);
    assert.equal(rollback.mock.callCount(), 1);
    assert.equal(commit.mock.callCount(), 0);
});

test('logs de falha não expõem mensagem, SQL, parâmetros ou dados pessoais', async (t) => {
    const sensitive = new Error('maria@example.test telefone 41999991234');
    sensitive.code = 'ER_PARSE_ERROR';
    sensitive.sql = 'SELECT * FROM pacientes WHERE email = maria@example.test';
    sensitive.sqlMessage = 'parâmetros privados';
    t.mock.method(pool, 'execute', async () => { throw sensitive; });
    const logged = [];
    t.mock.method(console, 'error', (...args) => logged.push(args));
    const res = response();
    await controller.listForManagement({ tenant: { clinicId: 11 }, query: {} }, res);
    assert.equal(res.statusCode, 500);
    const serialized = JSON.stringify(logged);
    assert.match(serialized, /ER_PARSE_ERROR/);
    assert.doesNotMatch(serialized, /maria@example|41999991234|SELECT \*|parâmetros privados/);
});

test('consulta de CEP usa proxy por tenant e não recebe dados pessoais', async (t) => {
    const lookup = t.mock.method(cepService, 'lookupCep', async (cep, options) => {
        assert.equal(cep, '01001000');
        assert.deepEqual(options, { rateKey: '11:7' });
        return { kind: 'found', address: {
            cep, logradouro: 'Praça da Sé', bairro: 'Sé', cidade: 'São Paulo', uf: 'SP'
        } };
    });
    const res = response();
    await controller.lookupCep({
        params: { cep: '01001-000' }, tenant: { clinicId: 11 }, userId: 7,
        body: { nome: 'não deve ser encaminhado', cpf: '52998224725' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(lookup.mock.callCount(), 1);
    assert.equal('nome' in res.body, false);
    assert.equal('cpf' in res.body, false);
});

test('rotas de gestão aceitam administrador, secretaria e titular do consultório', () => {
    const routes = router.stack.filter((layer) => layer.route).map((layer) => ({
        path: layer.route.path, methods: layer.route.methods, handlers: layer.route.stack.map((item) => item.handle)
    }));
    for (const path of ['/pacientes/gestao', '/pacientes/busca', '/pacientes/cep/:cep', '/pacientes/gestao/:id',
        '/pacientes/duplicidades', '/pacientes', '/pacientes/:id']) {
        assert.ok(routes.some((route) => route.path === path), `rota ausente: ${path}`);
    }
    const create = routes.find((route) => route.path === '/pacientes' && route.methods.post);
    const authorized = create.handlers[0];
    for (const role of ['administrador', 'secretaria']) {
        let called = false;
        authorized({ tenant: { role } }, response(), () => { called = true; });
        assert.equal(called, true);
    }
    let ownerCalled = false;
    authorized({ tenant: { role: 'profissional', isPracticeOwner: true } }, response(), () => {
        ownerCalled = true;
    });
    assert.equal(ownerCalled, true);
    for (const role of ['profissional', 'paciente']) {
        const res = response();
        authorized({ tenant: { role } }, res, () => {});
        assert.equal(res.statusCode, 403);
    }
});
