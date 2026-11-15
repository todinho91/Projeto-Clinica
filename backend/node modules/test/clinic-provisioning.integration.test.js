const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('../scripts/db/config');
const { runMigrations } = require('../scripts/db/migrator');
const { assertProvisioningDisposableDatabaseName } = require('../support/mysql-test-safety');

const enabled = process.env.PROVISIONING_INTEGRATION_TEST === '1';
const migrationsDir = path.join(__dirname, '..', '..', 'database', 'migrations');

function response() {
    return { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

async function resetSchema(connection, database) {
    assertProvisioningDisposableDatabaseName(database);
    const [[selected]] = await connection.query('SELECT DATABASE() AS database_name');
    if (selected.database_name !== database) throw new Error('Conexão não aponta para o banco descartável autorizado.');
    const tables = [
        'auditoria_plataforma', 'convites_clinica', 'auditoria', 'documentos_clinicos',
        'consultas', 'pacientes', 'profissional_especialidades', 'profissionais',
        'especialidades', 'clinica_usuarios', 'operadores_plataforma', 'usuarios',
        'clinicas', 'schema_migrations'
    ];
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
        for (const table of tables) await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
    } finally {
        await connection.query('SET FOREIGN_KEY_CHECKS = 1');
    }
}

test('MySQL 8 provisiona uma vez sob concorrência e preserva isolamento', {
    skip: !enabled
}, async () => {
    const config = loadDatabaseConfig(process.env, 'TEST_DB_');
    assertProvisioningDisposableDatabaseName(config.database);
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
        const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 4);
        const [operatorUser] = await setup.execute(`
            INSERT INTO usuarios (nome, email, senha_hash, status, motivo_bloqueio)
            VALUES ('Operador Teste', 'operador@example.test', ?, 'ativo', 'nenhum')
        `, [passwordHash]);
        await setup.execute(
            "INSERT INTO operadores_plataforma (usuario_id, status) VALUES (?, 'ativo')",
            [operatorUser.insertId]
        );

        pool = require('../config/database');
        const controller = require('../controllers/clinicaController');
        const payload = {
            nome: 'Clínica Concorrente', slug: 'clinica-concorrente',
            timezone: 'America/Sao_Paulo', status: 'ativa',
            administrador_nome: 'Administrador Novo',
            administrador_email: 'admin.novo@example.test'
        };
        const first = response();
        const second = response();
        await Promise.all([
            controller.provision({ userId: Number(operatorUser.insertId), body: payload }, first),
            controller.provision({ userId: Number(operatorUser.insertId), body: payload }, second)
        ]);
        assert.deepEqual([first.statusCode, second.statusCode].sort(), [201, 409]);
        const [[clinics]] = await setup.execute(
            'SELECT COUNT(*) AS total FROM clinicas WHERE slug = ?', [payload.slug]
        );
        assert.equal(Number(clinics.total), 1);
        const [[link]] = await setup.execute(`
            SELECT cu.papel, cu.status, c.slug,
                   u.status AS usuario_status, u.motivo_bloqueio
            FROM clinica_usuarios cu JOIN clinicas c ON c.id = cu.clinica_id
            JOIN usuarios u ON u.id = cu.usuario_id
            WHERE u.email = ?
        `, [payload.administrador_email]);
        assert.deepEqual(
            {
                papel: link.papel, status: link.status, slug: link.slug,
                usuario_status: link.usuario_status, motivo_bloqueio: link.motivo_bloqueio
            },
            {
                papel: 'administrador', status: 'convite_pendente', slug: payload.slug,
                usuario_status: 'bloqueado', motivo_bloqueio: 'ativacao_pendente'
            }
        );
        const [[audit]] = await setup.execute(
            "SELECT COUNT(*) AS total FROM auditoria_plataforma WHERE acao = 'clinica_provisionada'"
        );
        assert.equal(Number(audit.total), 1);
    } finally {
        if (pool) await pool.end();
        await setup.end();
    }
});
