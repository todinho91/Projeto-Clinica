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
const { login } = require('../controllers/authController');
const authenticate = require('../middleware/auth');

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

test('login assina um token HS256 aceito pelo middleware', async (t) => {
    const hash = await bcrypt.hash('fixture-login', 4);
    t.mock.method(pool, 'query', async () => [[{ id: 42, tipo: 'paciente', senha: hash }]]);
    const res = response();

    await login({ body: { email: 'fixture@example.test', senha: 'fixture-login' } }, res);

    assert.equal(res.statusCode, 200);
    const decoded = jwt.verify(res.body.token, testConfig.JWT_SECRET, { algorithms: ['HS256'] });
    assert.equal(decoded.exp - decoded.iat, 8 * 60 * 60);
    const req = { headers: { authorization: `Bearer ${res.body.token}` } };
    const next = t.mock.fn();
    authenticate(req, response(), next);
    assert.equal(next.mock.callCount(), 1);
    assert.equal(req.userId, 42);
    assert.equal(req.userTipo, 'paciente');
});

test('login com senha incorreta não emite token', async (t) => {
    const hash = await bcrypt.hash('fixture-login', 4);
    t.mock.method(pool, 'query', async () => [[{ id: 42, tipo: 'paciente', senha: hash }]]);
    const res = response();

    await login({ body: { email: 'fixture@example.test', senha: 'incorreta' } }, res);

    assert.equal(res.statusCode, 401);
    assert.equal(res.body.token, undefined);
});

const claims = { id: 42, tipo: 'paciente' };
const signed = jwt.sign(claims, testConfig.JWT_SECRET);
const parts = signed.split('.');
parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);

for (const [name, authorization] of [
    ['ausente', undefined],
    ['com esquema inválido', `Basic ${signed}`],
    ['adulterado', `Bearer ${parts.join('.')}`],
    ['assinado com chave anterior', `Bearer ${jwt.sign(claims, randomBytes(32))}`],
    ['expirado', `Bearer ${jwt.sign(claims, testConfig.JWT_SECRET, { expiresIn: -1 })}`],
    ['com algoritmo fora da lista', `Bearer ${jwt.sign(claims, testConfig.JWT_SECRET, { algorithm: 'HS384' })}`]
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
