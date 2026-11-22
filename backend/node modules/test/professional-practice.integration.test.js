const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../scripts/db/config');
const { runMigrations } = require('../scripts/db/migrator');
const {
    assertPracticeDisposableDatabaseName,
    confirmPracticeTestEnvironment
} = require('../support/mysql-test-safety');

const enabled = process.env.PRACTICE_INTEGRATION_TEST === '1';
const migrationsDir = path.join(__dirname, '..', '..', 'database', 'migrations');

function response() {
    return {
        statusCode: null, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

async function resetSchema(connection, database) {
    await confirmPracticeTestEnvironment(connection, database);
    const [rows] = await connection.query(`
        SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
    `, [database]);
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        for (const row of rows) {
            const table = String(row.TABLE_NAME).replace(/`/g, '');
            await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
        }
    } finally { await connection.query('SET FOREIGN_KEY_CHECKS = 1'); }
}

async function createVerifiedProfessional(connection, suffix) {
    const hash = await bcrypt.hash(randomBytes(24).toString('hex'), 4);
    const [user] = await connection.execute(`
        INSERT INTO usuarios (nome, email, senha_hash, status, motivo_bloqueio)
        VALUES (?, ?, ?, 'ativo', 'nenhum')
    `, [`Profissional ${suffix}`, `profissional.${suffix}@example.test`, hash]);
    const [operatorUser] = await connection.execute(`
        INSERT INTO usuarios (nome, email, senha_hash, status, motivo_bloqueio)
        VALUES (?, ?, ?, 'ativo', 'nenhum')
    `, [`Operador ${suffix}`, `operador.${suffix}@example.test`, hash]);
    const [operator] = await connection.execute(`
        INSERT INTO operadores_plataforma (usuario_id, status) VALUES (?, 'ativo')
    `, [operatorUser.insertId]);
    await connection.execute(`
        INSERT INTO identidades_profissionais (
            usuario_id, tipo_profissional, conselho_tipo, conselho_numero,
            conselho_uf, status_verificacao, verificado_por_operador_id, verificado_em
        ) VALUES (?, 'Médico', 'CRM', ?, 'SP', 'verificada', ?, UTC_TIMESTAMP(6))
    `, [user.insertId, `M3${suffix}`, operator.insertId]);
    return Number(user.insertId);
}

test('MySQL 8 valida provisionamento, concorrência, rollback e isolamento de consultórios', {
    skip: !enabled
}, async () => {
    const config = loadDatabaseConfig(process.env, 'TEST_DB_');
    assertPracticeDisposableDatabaseName(config.database);
    Object.assign(process.env, {
        DB_HOST: config.host, DB_PORT: String(config.port), DB_USER: config.user,
        DB_PASSWORD: config.password, DB_DATABASE: config.database,
        JWT_SECRET: randomBytes(32).toString('hex'), MAIL_PROVIDER: 'disabled',
        APP_PUBLIC_ORIGIN: 'http://127.0.0.1:5500'
    });
    const setup = await mysql.createConnection({ ...config, multipleStatements: true });
    let pool;
    try {
        await resetSchema(setup, config.database);
        await runMigrations({ connection: setup, migrationsDir, logger: { info() {} } });
        const ownerA = await createVerifiedProfessional(setup, 'a');
        const ownerB = await createVerifiedProfessional(setup, 'b');
        pool = require('../config/database');
        const controller = require('../controllers/consultorioController');
        const payloadA = {
            nome: 'Consultório A', slug: 'consultorio-a', timezone: 'America/Sao_Paulo',
            nome_exibicao: 'Profissional A'
        };
        const first = response(); const concurrent = response();
        await Promise.all([
            controller.provision({ userId: ownerA, body: payloadA }, first),
            controller.provision({ userId: ownerA, body: payloadA }, concurrent)
        ]);
        assert.deepEqual([first.statusCode, concurrent.statusCode].sort(), [201, 409]);
        const clinicA = Number((first.statusCode === 201 ? first : concurrent).body.id);
        const [[complete]] = await setup.execute(`
            SELECT cp.titular_usuario_id, cu.papel, cu.status AS vinculo_status,
                   p.status AS profissional_status
            FROM consultorios_profissionais cp
            JOIN clinica_usuarios cu ON cu.clinica_id = cp.clinica_id
              AND cu.usuario_id = cp.titular_usuario_id
            JOIN profissionais p ON p.clinica_id = cp.clinica_id
              AND p.usuario_id = cp.titular_usuario_id
            WHERE cp.clinica_id = ?
        `, [clinicA]);
        assert.deepEqual({
            titular_usuario_id: Number(complete.titular_usuario_id), papel: complete.papel,
            vinculo_status: complete.vinculo_status, profissional_status: complete.profissional_status
        }, {
            titular_usuario_id: ownerA, papel: 'profissional',
            vinculo_status: 'ativo', profissional_status: 'ativo'
        });

        await setup.query(`ALTER TABLE consultorios_profissionais
            ADD CONSTRAINT chk_consultorio_rollback_teste CHECK (titular_usuario_id <> ${ownerB})`);
        const failed = response();
        await controller.provision({ userId: ownerB, body: {
            nome: 'Consultório Rollback', slug: 'consultorio-rollback',
            timezone: 'America/Sao_Paulo', nome_exibicao: 'Profissional B'
        } }, failed);
        assert.equal(failed.statusCode, 500);
        const [[rolledBack]] = await setup.execute(`
            SELECT COUNT(*) AS total FROM clinicas WHERE slug = 'consultorio-rollback'
        `);
        assert.equal(Number(rolledBack.total), 0);
        await setup.query(`ALTER TABLE consultorios_profissionais
            DROP CHECK chk_consultorio_rollback_teste`);

        const second = response();
        await controller.provision({ userId: ownerB, body: {
            nome: 'Consultório B', slug: 'consultorio-b', timezone: 'America/Manaus',
            nome_exibicao: 'Profissional B'
        } }, second);
        assert.equal(second.statusCode, 201);
        const clinicB = Number(second.body.id);

        const location = response();
        await controller.createLocation({
            userId: ownerA, tenant: { clinicId: clinicA, role: 'profissional' },
            body: { nome: 'Unidade A', endereco_linha: 'Rua A, 1', cidade: 'São Paulo', uf: 'SP' }
        }, location);
        assert.equal(location.statusCode, 201);
        const crossTenant = response();
        await controller.updateLocationStatus({
            userId: ownerB, tenant: { clinicId: clinicB, role: 'profissional' },
            params: { id: location.body.id }, body: { status: 'inativo' }
        }, crossTenant);
        assert.equal(crossTenant.statusCode, 404);
        const [[preserved]] = await setup.execute(`
            SELECT status FROM consultorio_locais WHERE clinica_id = ? AND id = ?
        `, [clinicA, location.body.id]);
        assert.equal(preserved.status, 'ativo');
    } finally {
        await pool?.end();
        await setup.end();
    }
});

test('proteção destrutiva recusa bancos de demonstração e valida SELECTs antes da limpeza', () => {
    assert.equal(
        assertPracticeDisposableDatabaseName('vitalis_consultorios_local_test'),
        'vitalis_consultorios_local_test'
    );
    for (const unsafe of ['vitalis_m3_validacao', 'vitalis_dev', 'vitalis_consultorios']) {
        assert.throws(() => assertPracticeDisposableDatabaseName(unsafe), /Operação recusada/);
    }
    const source = require('node:fs').readFileSync(__filename, 'utf8');
    assert.ok(source.indexOf('confirmPracticeTestEnvironment') < source.indexOf('DROP TABLE'));
    const safety = require('node:fs').readFileSync(
        path.join(__dirname, '..', 'support', 'mysql-test-safety.js'), 'utf8'
    );
    assert.match(safety, /SELECT DATABASE\(\)/);
    assert.match(safety, /SELECT VERSION\(\)/);
});
