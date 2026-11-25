const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const testConfig = {
    DB_HOST: '127.0.0.1',
    DB_USER: 'fixture_user',
    DB_PASSWORD: 'fixture_password',
    DB_DATABASE: 'fixture_database',
    PORT: '3000',
    JWT_SECRET: randomBytes(32).toString('hex')
};
Object.assign(process.env, testConfig);

const pool = require('../config/database');
const { clinicToken, login, register, selectClinic } = require('../controllers/authController');
const authenticate = require('../middleware/auth');
const identityOnly = require('../middleware/identityOnly');

function response() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
}

test('login emite token de identidade HS256 e lista vínculos ativos', async (t) => {
    const hash = await bcrypt.hash('fixture-login', 4);
    t.mock.method(pool, 'execute', async (sql) => {
        if (/FROM usuarios/.test(sql)) {
            return [[{ id: 42, nome: 'Paciente Demo', email: 'fixture@example.test', senha_hash: hash }]];
        }
        if (/FROM clinica_usuarios/.test(sql)) {
            return [[{ id: 7, nome: 'Clínica Demo', slug: 'demo', papel: 'paciente' }]];
        }
        throw new Error(`SQL inesperado: ${sql}`);
    });
    const res = response();

    await login({ body: { email: 'FIXTURE@example.test', senha: 'fixture-login' } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.clinicas[0].id, 7);
    assert.deepEqual(res.body.clinicas[0].permissoes, {
        gerenciar_disponibilidade: false
    });
    const decoded = jwt.verify(res.body.token, testConfig.JWT_SECRET, { algorithms: ['HS256'] });
    assert.equal(decoded.sub, '42');
    assert.equal(decoded.token_type, 'identity');
    assert.equal(decoded.exp - decoded.iat, 8 * 60 * 60);

    const req = { headers: { authorization: `Bearer ${res.body.token}` } };
    const next = t.mock.fn();
    authenticate(req, response(), next);
    assert.equal(next.mock.callCount(), 1);
    assert.equal(req.userId, 42);
    assert.deepEqual(req.auth, { tokenType: 'identity', clinicId: null, membershipVersion: null });
});

test('login com senha incorreta não emite token', async (t) => {
    const hash = await bcrypt.hash('fixture-login', 4);
    t.mock.method(pool, 'execute', async () => [[{
        id: 42,
        nome: 'Paciente Demo',
        email: 'fixture@example.test',
        senha_hash: hash
    }]]);
    const res = response();

    await login({ body: { email: 'fixture@example.test', senha: 'incorreta' } }, res);

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.token, undefined);
});

test('seleção de clínica assina a versão atual do vínculo', async (t) => {
    t.mock.method(pool,'execute',async()=>[[{
        id:7,nome:'Consultório Demo',slug:'demo',papel:'secretaria',sessao_versao:9,
        tipo_contexto:'consultorio',titular:0,gerenciar_disponibilidade:1
    }]]);
    const res=response(); await selectClinic({userId:42,body:{clinica_id:7}},res);
    assert.equal(res.statusCode,200);
    const decoded=jwt.verify(res.body.token,testConfig.JWT_SECRET,{algorithms:['HS256']});
    assert.equal(decoded.membership_version,9);
    assert.deepEqual(res.body.clinica.permissoes, {
        gerenciar_disponibilidade: true
    });
    const req={headers:{authorization:`Bearer ${res.body.token}`}};
    authenticate(req,response(),()=>{});
    assert.equal(req.auth.membershipVersion,9);
});

test('JWT de clínica revogado não pode obter novo token de clínica', (t) => {
    const revokedClinicToken=clinicToken(42,7,3);
    const req={headers:{authorization:`Bearer ${revokedClinicToken}`}};
    const authNext=t.mock.fn();
    authenticate(req,response(),authNext);
    assert.equal(authNext.mock.callCount(),1);
    assert.equal(req.auth.tokenType,'clinic');

    const res=response(); const identityNext=t.mock.fn();
    identityOnly(req,res,identityNext);
    assert.equal(res.statusCode,403);
    assert.equal(identityNext.mock.callCount(),0);
});

test('cadastro público rejeita papel privilegiado antes de acessar o banco', async (t) => {
    const getConnection = t.mock.method(pool, 'getConnection', async () => {
        throw new Error('não deveria acessar o banco');
    });
    const res = response();

    await register({
        body: {
            nome: 'Usuário Demo',
            email: 'novo@example.test',
            senha: 'senha-ficticia-forte',
            clinica_slug: 'demo',
            papel: 'administrador'
        }
    }, res);

    assert.equal(res.statusCode, 403);
    assert.equal(getConnection.mock.callCount(), 0);
});

test('cadastro público desfaz a transação quando a criação do vínculo falha', async (t) => {
    const connection = {
        beginTransaction: t.mock.fn(async () => {}),
        commit: t.mock.fn(async () => {}),
        rollback: t.mock.fn(async () => {}),
        release: t.mock.fn(),
        execute: t.mock.fn(async (sql) => {
            if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 7 }]];
            if (/SELECT id FROM pacientes/.test(sql)) return [[]];
            if (/INSERT INTO usuarios/.test(sql)) return [{ insertId: 42 }];
            if (/INSERT INTO clinica_usuarios/.test(sql)) {
                const error = new Error('paciente@example.test e parâmetros privados');
                error.code = 'ER_TEST_FAILURE';
                error.sql = 'INSERT INTO clinica_usuarios ...';
                throw error;
            }
            throw new Error(`SQL inesperado: ${sql}`);
        })
    };
    t.mock.method(pool, 'getConnection', async () => connection);
    const logged = [];
    t.mock.method(console, 'error', (...args) => logged.push(args));
    const res = response();

    await register({
        body: {
            nome: 'Paciente Demo',
            email: 'paciente@example.test',
            senha: 'senha-ficticia-forte',
            clinica_slug: 'demo'
        }
    }, res);

    assert.equal(res.statusCode, 500);
    assert.equal(connection.beginTransaction.mock.callCount(), 1);
    assert.equal(connection.rollback.mock.callCount(), 1);
    assert.equal(connection.commit.mock.callCount(), 0);
    assert.equal(connection.release.mock.callCount(), 1);
    const serialized = JSON.stringify(logged);
    assert.match(serialized, /ER_TEST_FAILURE/);
    assert.doesNotMatch(serialized, /paciente@example|INSERT INTO|parâmetros privados/);
});

test('cadastro público não apropria perfil administrativo preexistente', async (t) => {
    const connection = {
        beginTransaction: t.mock.fn(async () => {}),
        commit: t.mock.fn(async () => {}),
        rollback: t.mock.fn(async () => {}),
        release: t.mock.fn(),
        execute: t.mock.fn(async (sql, params) => {
            if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 7 }]];
            if (/SELECT id FROM pacientes/.test(sql)) {
                assert.deepEqual(params, [7, 'preexistente@example.test', 'Paciente Preexistente']);
                return [[{ id: 99 }]];
            }
            throw new Error('nenhuma escrita deveria ocorrer');
        })
    };
    const hash = t.mock.method(bcrypt, 'hash', async () => 'hash-sintetico-uniforme');
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();

    await register({ body: {
        nome: 'Paciente Preexistente', email: 'preexistente@example.test',
        senha: 'senha-ficticia-forte', clinica_slug: 'demo'
    } }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'Não foi possível concluir o cadastro com os dados informados.');
    assert.equal(connection.rollback.mock.callCount(), 1);
    assert.equal(connection.commit.mock.callCount(), 0);
    assert.equal(hash.mock.callCount(), 1);
    assert.equal(connection.execute.mock.calls.some((call) => /INSERT INTO/.test(call.arguments[0])), false);
});

test('cadastro público bloqueia nome clínico equivalente com resposta neutra e sem vínculo', async (t) => {
    const connection = {
        beginTransaction: t.mock.fn(async () => {}), commit: t.mock.fn(async () => {}),
        rollback: t.mock.fn(async () => {}), release: t.mock.fn(),
        execute: t.mock.fn(async (sql, params) => {
            if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 7 }]];
            if (/SELECT id FROM pacientes/.test(sql)) {
                assert.deepEqual(params, [7, 'outra.identidade@example.test', 'Joao da Silva']);
                return [[{ id: 99 }]];
            }
            throw new Error('nenhuma identidade ou vínculo deveria ser criado');
        })
    };
    t.mock.method(bcrypt, 'hash', async () => 'hash-sintetico-uniforme');
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();
    await register({ body: {
        nome: '  Joao   da Silva ', email: 'outra.identidade@example.test',
        senha: 'senha-ficticia-forte', clinica_slug: 'demo'
    } }, res);
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, { error: 'Não foi possível concluir o cadastro com os dados informados.' });
    assert.equal(connection.execute.mock.calls.some((call) => /INSERT INTO/.test(call.arguments[0])), false);
    assert.equal(connection.rollback.mock.callCount(), 1);
});

test('conflito tardio de perfil público desfaz usuário e vínculo parciais', async (t) => {
    const connection = {
        beginTransaction: t.mock.fn(async () => {}),
        commit: t.mock.fn(async () => {}),
        rollback: t.mock.fn(async () => {}),
        release: t.mock.fn(),
        execute: t.mock.fn(async (sql) => {
            if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 7 }]];
            if (/SELECT id FROM pacientes/.test(sql)) return [[]];
            if (/INSERT INTO usuarios/.test(sql)) return [{ insertId: 42 }];
            if (/INSERT INTO clinica_usuarios/.test(sql)) return [{ affectedRows: 1 }];
            if (/INSERT INTO pacientes/.test(sql)) {
                const error = new Error('dados pessoais e SQL não devem aparecer no log');
                error.code = 'ER_DUP_ENTRY';
                error.sql = 'INSERT INTO pacientes ...';
                throw error;
            }
            throw new Error('SQL inesperado');
        })
    };
    t.mock.method(bcrypt, 'hash', async () => 'hash-sintetico');
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();

    await register({ body: {
        nome: 'Paciente Concorrente', email: 'concorrente@example.test',
        senha: 'senha-ficticia-forte', clinica_slug: 'demo'
    } }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'Não foi possível concluir o cadastro com os dados informados.');
    assert.equal(connection.rollback.mock.callCount(), 1);
    assert.equal(connection.commit.mock.callCount(), 0);
});

test('conflitos de identidade global e perfil clínico usam a mesma resposta neutra', async (t) => {
    const connection = {
        beginTransaction: t.mock.fn(async () => {}),
        commit: t.mock.fn(async () => {}),
        rollback: t.mock.fn(async () => {}),
        release: t.mock.fn(),
        execute: t.mock.fn(async (sql) => {
            if (/SELECT id FROM clinicas/.test(sql)) return [[{ id: 7 }]];
            if (/SELECT id FROM pacientes/.test(sql)) return [[]];
            if (/INSERT INTO usuarios/.test(sql)) {
                const error = new Error('identidade existente');
                error.code = 'ER_DUP_ENTRY';
                throw error;
            }
            throw new Error('SQL inesperado');
        })
    };
    t.mock.method(bcrypt, 'hash', async () => 'hash-sintetico');
    t.mock.method(pool, 'getConnection', async () => connection);
    const res = response();

    await register({ body: {
        nome: 'Identidade Existente', email: 'identidade@example.test',
        senha: 'senha-ficticia-forte', clinica_slug: 'demo'
    } }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'Não foi possível concluir o cadastro com os dados informados.');
    assert.equal(connection.rollback.mock.callCount(), 1);
    assert.equal(connection.commit.mock.callCount(), 0);
});

const claims = { sub: '42', token_type: 'identity' };
const signed = jwt.sign(claims, testConfig.JWT_SECRET);
const parts = signed.split('.');
parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);

for (const [name, authorization] of [
    ['ausente', undefined],
    ['com esquema inválido', `Basic ${signed}`],
    ['adulterado', `Bearer ${parts.join('.')}`],
    ['assinado com chave anterior', `Bearer ${jwt.sign(claims, randomBytes(32))}`],
    ['expirado', `Bearer ${jwt.sign(claims, testConfig.JWT_SECRET, { expiresIn: -1 })}`],
    ['com algoritmo fora da lista', `Bearer ${jwt.sign(claims, testConfig.JWT_SECRET, { algorithm: 'HS384' })}`],
    ['sem usuário válido', `Bearer ${jwt.sign({ token_type: 'identity' }, testConfig.JWT_SECRET)}`]
]) {
    test(`middleware rejeita token ${name}`, (t) => {
        const res = response();
        const next = t.mock.fn();

        authenticate({ headers: { authorization } }, res, next);

        assert.equal(res.statusCode, 401);
        assert.equal(next.mock.callCount(), 0);
    });
}

for (const [name, value, message] of [
    ['JWT_SECRET', '', /Configuração obrigatória ausente: JWT_SECRET/],
    ['JWT_SECRET', 'fixture-curto', /JWT_SECRET deve ter pelo menos 32 bytes/],
    ['DB_PASSWORD', '', /Configuração obrigatória ausente: DB_PASSWORD/],
    ['PORT', '65536', /PORT deve ser um inteiro entre 1 e 65535/]
]) {
    test(`servidor falha na inicialização com configuração inválida em ${name}: ${message.source}`, () => {
        const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'server.js')], {
            env: { ...process.env, ...testConfig, [name]: value },
            encoding: 'utf8',
            timeout: 5000
        });

        assert.equal(result.status, 1);
        assert.match(result.stderr, message);
        assert.doesNotMatch(result.stdout, /Servidor rodando/);
    });
}
