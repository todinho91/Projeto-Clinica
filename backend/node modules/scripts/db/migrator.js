const { createHash } = require('node:crypto');
const { promises: fs } = require('node:fs');
const path = require('node:path');

const MIGRATION_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;
const LOCK_NAME = 'vitalis_schema_migrations';

function checksum(sql) {
    return createHash('sha256').update(sql, 'utf8').digest('hex');
}

async function loadMigrations(migrationsDir) {
    const entries = await fs.readdir(migrationsDir, { withFileTypes: true });
    const files = entries
        .filter((entry) => entry.isFile() && MIGRATION_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort();

    if (files.length === 0) {
        throw new Error(`Nenhuma migration encontrada em ${migrationsDir}.`);
    }

    const migrations = [];
    for (const version of files) {
        const sql = await fs.readFile(path.join(migrationsDir, version), 'utf8');
        if (!sql.trim()) {
            throw new Error(`Migration vazia: ${version}.`);
        }
        migrations.push({ version, sql, checksum: checksum(sql) });
    }
    return migrations;
}

async function ensureMigrationTable(connection) {
    await connection.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version VARCHAR(255) NOT NULL,
            checksum CHAR(64) NOT NULL,
            aplicado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
            PRIMARY KEY (version)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
}

async function acquireLock(connection) {
    const [rows] = await connection.execute(
        'SELECT GET_LOCK(?, 30) AS acquired',
        [LOCK_NAME]
    );
    if (!rows[0] || Number(rows[0].acquired) !== 1) {
        throw new Error('Não foi possível obter o lock das migrations.');
    }
}

async function releaseLock(connection) {
    await connection.execute('SELECT RELEASE_LOCK(?) AS released', [LOCK_NAME]);
}

// Refuse replay of a partially committed 017; never reconcile or delete automatically.
async function assertClean017(connection) {
    const [rows] = await connection.query(`
        SELECT
        (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
         AND TABLE_NAME IN ('prontuario_chaves','prontuario_envelopes','prontuario_negativas')) AS tables_present,
        (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE()
         AND CONSTRAINT_NAME IN ('chk_prontuario_sem_texto_puro','fk_prontuario_profissional_autor')) AS constraints_present,
        (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
         AND TABLE_NAME='profissionais' AND INDEX_NAME='uk_profissionais_prontuario_autor') AS indexes_present,
        (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
         AND TABLE_NAME='prontuario_versoes' AND COLUMN_NAME IN ('conteudo','autor_snapshot') AND IS_NULLABLE='NO') AS original_columns
    `);
    const row=rows[0];
    if (!row || Number(row.tables_present)!==0 || Number(row.constraints_present)!==0 ||
        Number(row.indexes_present)!==0 || Number(row.original_columns)!==2) {
        throw new Error('MIGRATION_017_PARTIAL: restaure snapshot pré-017 em schema isolado e valide; não repita DDL.');
    }
    const [versions]=await connection.query('SELECT 1 FROM prontuario_versoes LIMIT 1');
    if (versions.length) throw new Error('MIGRATION_017_LEGACY: versões existentes exigem conversão autorizada.');
}

async function runMigrations({ connection, migrationsDir, logger = console }) {
    await ensureMigrationTable(connection);
    await acquireLock(connection);

    const appliedNow = [];
    const skipped = [];
    try {
        const migrations = await loadMigrations(migrationsDir);
        const [rows] = await connection.query(
            'SELECT version, checksum FROM schema_migrations ORDER BY version'
        );
        const applied = new Map(rows.map((row) => [row.version, row.checksum]));

        for (const migration of migrations) {
            const existingChecksum = applied.get(migration.version);
            if (existingChecksum) {
                if (existingChecksum !== migration.checksum) {
                    throw new Error(
                        `Checksum divergente para migration já aplicada: ${migration.version}.`
                    );
                }
                skipped.push(migration.version);
                continue;
            }

            if (migration.version === '017_clinical_record_encryption.sql') await assertClean017(connection);
            await connection.query(migration.sql);
            await connection.execute(
                'INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)',
                [migration.version, migration.checksum]
            );
            appliedNow.push(migration.version);
            logger.info(`Migration aplicada: ${migration.version}`);
        }
    } finally {
        await releaseLock(connection);
    }

    return { applied: appliedNow, skipped };
}

module.exports = {
    LOCK_NAME,
    checksum,
    loadMigrations,
    runMigrations
};
