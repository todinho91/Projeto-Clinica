const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { runMigrations } = require('../scripts/db/migrator');

class FakeMigrationConnection {
    constructor() {
        this.applied = new Map();
        this.executedSql = [];
    }

    async query(sql) {
        if (/SELECT version, checksum FROM schema_migrations/.test(sql)) {
            return [[...this.applied].map(([version, checksum]) => ({ version, checksum }))];
        }
        if (!/CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql)) {
            this.executedSql.push(sql.trim());
        }
        return [[]];
    }

    async execute(sql, params) {
        if (/GET_LOCK/.test(sql)) return [[{ acquired: 1 }]];
        if (/RELEASE_LOCK/.test(sql)) return [[{ released: 1 }]];
        if (/INSERT INTO schema_migrations/.test(sql)) {
            this.applied.set(params[0], params[1]);
            return [{ affectedRows: 1 }];
        }
        throw new Error(`SQL inesperado no fake: ${sql}`);
    }
}

async function tempMigrations(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vitalis-migrations-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, '002_second.sql'), 'CREATE TABLE second_table (id INT);');
    await fs.writeFile(path.join(dir, '001_first.sql'), 'CREATE TABLE first_table (id INT);');
    return dir;
}

test('executor aplica migrations em ordem e não repete versões', async (t) => {
    const migrationsDir = await tempMigrations(t);
    const connection = new FakeMigrationConnection();
    const logger = { info() {} };

    const first = await runMigrations({ connection, migrationsDir, logger });
    assert.deepEqual(first.applied, ['001_first.sql', '002_second.sql']);
    assert.equal(connection.executedSql.length, 2);

    const second = await runMigrations({ connection, migrationsDir, logger });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, ['001_first.sql', '002_second.sql']);
    assert.equal(connection.executedSql.length, 2);
});

test('executor recusa alteração em migration já aplicada', async (t) => {
    const migrationsDir = await tempMigrations(t);
    const connection = new FakeMigrationConnection();
    const logger = { info() {} };

    await runMigrations({ connection, migrationsDir, logger });
    await fs.writeFile(path.join(migrationsDir, '001_first.sql'), 'CREATE TABLE changed (id INT);');

    await assert.rejects(
        runMigrations({ connection, migrationsDir, logger }),
        /Checksum divergente/
    );
});
