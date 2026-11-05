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
