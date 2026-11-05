const path = require('node:path');
const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('./config');
const { runMigrations } = require('./migrator');

const migrationsDir = path.join(__dirname, '..', '..', '..', 'database', 'migrations');

async function migrate() {
    const connection = await mysql.createConnection({
        ...loadDatabaseConfig(),
        multipleStatements: true
    });
    try {
        const result = await runMigrations({ connection, migrationsDir });
        console.info(
            `Migrations concluídas: ${result.applied.length} aplicada(s), ` +
            `${result.skipped.length} já existente(s).`
        );
        return result;
    } finally {
        await connection.end();
    }
}

if (require.main === module) {
    migrate().catch((error) => {
        console.error(`Falha ao executar migrations: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { migrate, migrationsDir };
