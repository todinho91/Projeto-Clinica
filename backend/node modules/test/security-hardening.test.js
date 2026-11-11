const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

Object.assign(process.env, {
    DB_HOST: '127.0.0.1',
    DB_USER: 'fixture_user',
    DB_PASSWORD: 'fixture_password',
    DB_DATABASE: 'fixture_database',
    PORT: '3000',
    JWT_SECRET: randomBytes(32).toString('hex'),
    CORS_ORIGINS: 'http://127.0.0.1:5500,http://localhost:5500'
});

const app = require('../server');
const multerConfig = require('../config/multerConfig');
const pool = require('../config/database');
const { uploadExame } = require('../controllers/exameController');
const { hasExpectedSignature } = require('../support/file-signature');

function response() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

test('CORS aceita somente origens configuradas', async (t) => {
    const server = app.listen(0);
    t.after(() => server.close());
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();

    const allowed = await fetch(`http://127.0.0.1:${port}/rota-inexistente`, {
        headers: { Origin: 'http://127.0.0.1:5500' }
    });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5500');

    const denied = await fetch(`http://127.0.0.1:${port}/rota-inexistente`, {
        headers: { Origin: 'https://maliciosa.example' }
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('configuração recusa curinga de CORS antes de iniciar o servidor', () => {
    const result = spawnSync(process.execPath, ['-e', 'require("./config/environment")'], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, CORS_ORIGINS: '*' },
        encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CORS_ORIGINS deve listar origens explícitas/);
});

test('configuração de upload rejeita MIME e extensão incompatíveis', () => {
    const rejected = [];
    multerConfig.fileFilter({}, {
        fieldname: 'documento', originalname: 'payload.png', mimetype: 'application/pdf'
    }, (error) => rejected.push(error));
    assert.equal(rejected[0]?.code, 'LIMIT_UNEXPECTED_FILE');

    let accepted = false;
    multerConfig.fileFilter({}, {
        fieldname: 'documento', originalname: 'documento.pdf', mimetype: 'application/pdf'
    }, (error, result) => { assert.equal(error, null); accepted = result; });
    assert.equal(accepted, true);
});

test('assinaturas reais são verificadas para PDF, JPEG e PNG', async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'vitalis-signature-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const fixtures = [
        ['documento.pdf', Buffer.from('%PDF-1.7'), 'application/pdf'],
        ['imagem.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
        ['imagem.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png']
    ];
    for (const [name, contents, mimeType] of fixtures) {
        const filePath = path.join(directory, name);
        await writeFile(filePath, contents);
        assert.equal(await hasExpectedSignature(filePath, mimeType), true);
    }
});

test('upload com conteúdo forjado é removido antes de consultar o banco', async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'vitalis-upload-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const filePath = path.join(directory, 'forjado.pdf');
    await writeFile(filePath, 'isto não é um PDF');
    const execute = t.mock.method(pool, 'execute', async () => {
        throw new Error('não deveria consultar o banco');
    });
    const res = response();

    await uploadExame({
        body: { paciente_id: '1', titulo: 'Documento sintético' },
        file: { path: filePath, mimetype: 'application/pdf', filename: 'forjado.pdf', size: 18 },
        tenant: { clinicId: 1, role: 'administrador' },
        userId: 1
    }, res);

    assert.equal(res.statusCode, 415);
    assert.equal(execute.mock.callCount(), 0);
});

test('repositório não rastreia dependências, uploads nem arquivos de ambiente', () => {
    const repositoryRoot = path.resolve(__dirname, '..', '..', '..');
    const tracked = execFileSync('git', ['ls-files'], { cwd: repositoryRoot, encoding: 'utf8' })
        .trim().split('\n').filter(Boolean);
    assert.equal(tracked.some((file) => file.includes('/node_modules/')), false);
    assert.equal(tracked.some((file) => file.startsWith('backend/uploads/')), false);
    assert.equal(tracked.some((file) => /(^|\/)\.env($|\.)/.test(file) && !file.endsWith('.env.example')), false);
});
