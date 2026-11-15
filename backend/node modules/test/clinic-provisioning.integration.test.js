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

test('MySQL 8 valida provisionamento, reenvio concorrente, aceite, rollback e isolamento', {
    skip: !enabled
}, async (t) => {
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
        const [secondOperatorUser] = await setup.execute(`
            INSERT INTO usuarios (nome, email, senha_hash, status, motivo_bloqueio)
            VALUES ('Operador Dois', 'operador.dois@example.test', ?, 'ativo', 'nenhum')
        `, [passwordHash]);
        await setup.execute(
            "INSERT INTO operadores_plataforma (usuario_id, status) VALUES (?, 'ativo'), (?, 'ativo')",
            [operatorUser.insertId, secondOperatorUser.insertId]
        );

        pool = require('../config/database');
        const mailer = require('../services/invitation-mailer');
        const sentTokens = [];
        t.mock.method(mailer, 'sendInvitation', async (message) => {
            sentTokens.push(message);
            return { status: 'not_configured', delivered: false };
        });
        const controller = require('../controllers/clinicaController');
        const invitationController = require('../controllers/equipeController');
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
        const createdProvision = first.statusCode === 201 ? first : second;
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

        const firstToken = sentTokens.find(({ recipient }) => (
            recipient === payload.administrador_email
        ))?.token;
        assert.match(firstToken, /^[A-Za-z0-9_-]{43}$/);
        const accepted = response();
        await invitationController.acceptInvitation({
            params: { token: firstToken }, body: { senha: 'senha-inicial-segura-123' }
        }, accepted);
        assert.equal(accepted.statusCode, 200);
        const [[activated]] = await setup.execute(`
            SELECT cu.status AS vinculo_status, u.status AS usuario_status,
                   u.motivo_bloqueio, i.status AS convite_status
            FROM clinica_usuarios cu
            JOIN usuarios u ON u.id = cu.usuario_id
            JOIN convites_clinica i
              ON i.clinica_id = cu.clinica_id AND i.clinica_usuario_id = cu.id
            JOIN clinicas c ON c.id = cu.clinica_id
            WHERE c.slug = ? ORDER BY i.id DESC LIMIT 1
        `, [payload.slug]);
        assert.deepEqual(activated, {
            vinculo_status: 'ativo', usuario_status: 'ativo',
            motivo_bloqueio: 'nenhum', convite_status: 'aceito'
        });

        const recoveryProvision = response();
        const recoveryPayload = {
            ...payload,
            nome: 'Clínica Recuperação', slug: 'clinica-recuperacao',
            administrador_nome: 'Admin Recuperação',
            administrador_email: 'admin.recuperacao@example.test'
        };
        await controller.provision({
            userId: Number(operatorUser.insertId), body: recoveryPayload
        }, recoveryProvision);
        assert.equal(recoveryProvision.statusCode, 201);
        const recoveryClinicId = recoveryProvision.body.clinica.id;
        const originalInvitationId = recoveryProvision.body.convite_id;
        const originalToken = sentTokens.find(({ recipient }) => (
            recipient === recoveryPayload.administrador_email
        ))?.token;
        await setup.execute(
            'UPDATE convites_clinica SET expira_em = DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 MINUTE) WHERE id = ?',
            [originalInvitationId]
        );

        const crossTenant = response();
        await controller.reissueInitialInvitation({
            userId: Number(operatorUser.insertId),
            params: { clinicId: String(createdProvision.body.clinica.id), invitationId: String(originalInvitationId) }
        }, crossTenant);
        assert.equal(crossTenant.statusCode, 404);

        const reissueA = response();
        const reissueB = response();
        await Promise.all([
            controller.reissueInitialInvitation({
                userId: Number(operatorUser.insertId),
                params: { clinicId: String(recoveryClinicId), invitationId: String(originalInvitationId) }
            }, reissueA),
            controller.reissueInitialInvitation({
                userId: Number(secondOperatorUser.insertId),
                params: { clinicId: String(recoveryClinicId), invitationId: String(originalInvitationId) }
            }, reissueB)
        ]);
        assert.deepEqual([reissueA.statusCode, reissueB.statusCode].sort(), [201, 409]);
        const successfulReissue = reissueA.statusCode === 201 ? reissueA : reissueB;
        const oldAcceptance = response();
        await invitationController.acceptInvitation({
            params: { token: originalToken }, body: { senha: 'senha-antiga-invalida-123' }
        }, oldAcceptance);
        assert.equal(oldAcceptance.statusCode, 410);
        const replacementToken = sentTokens.filter(({ recipient }) => (
            recipient === recoveryPayload.administrador_email
        )).at(-1)?.token;
        assert.notEqual(replacementToken, originalToken);
        const newAcceptance = response();
        await invitationController.acceptInvitation({
            params: { token: replacementToken }, body: { senha: 'senha-recuperada-segura-123' }
        }, newAcceptance);
        assert.equal(newAcceptance.statusCode, 200);
        const [[reissueAudit]] = await setup.execute(`
            SELECT COUNT(*) AS total FROM auditoria_plataforma
            WHERE acao = 'convite_inicial_reenviado' AND clinica_id = ? AND entidade_id = ?
        `, [recoveryClinicId, successfulReissue.body.convite_id]);
        assert.equal(Number(reissueAudit.total), 1);

        await setup.query(`
            ALTER TABLE convites_clinica
            ADD CONSTRAINT chk_convite_rollback_teste
            CHECK (email_normalizado <> 'rollback@example.test')
        `);
        const rollbackResponse = response();
        let rollbackClinic;
        let rollbackUser;
        try {
            await controller.provision({
                userId: Number(operatorUser.insertId),
                body: {
                    ...payload,
                    nome: 'Clínica Rollback', slug: 'clinica-rollback',
                    administrador_nome: 'Admin Rollback',
                    administrador_email: 'rollback@example.test'
                }
            }, rollbackResponse);
            [[rollbackClinic]] = await setup.execute(
                "SELECT COUNT(*) AS total FROM clinicas WHERE slug = 'clinica-rollback'"
            );
            [[rollbackUser]] = await setup.execute(
                "SELECT COUNT(*) AS total FROM usuarios WHERE email = 'rollback@example.test'"
            );
        } finally {
            await setup.query(`
                ALTER TABLE convites_clinica
                DROP CHECK chk_convite_rollback_teste
            `);
        }
        assert.equal(rollbackResponse.statusCode, 500);
        assert.equal(Number(rollbackClinic.total), 0);
        assert.equal(Number(rollbackUser.total), 0);
    } finally {
        if (pool) await pool.end();
        await setup.end();
    }
});
