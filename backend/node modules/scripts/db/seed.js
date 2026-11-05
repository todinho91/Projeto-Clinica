const mysql = require('mysql2/promise');
const { loadDatabaseConfig } = require('./config');
const {
    readBcryptRounds,
    readSeedPassword,
    seedDatabase
} = require('./seeder');

async function seed() {
    const connection = await mysql.createConnection(loadDatabaseConfig());
    try {
        const results = await seedDatabase({
            connection,
            password: readSeedPassword(),
            rounds: readBcryptRounds()
        });
        console.info(`Seed concluído para ${results.length} clínica(s) sintética(s).`);
        return results;
    } finally {
        await connection.end();
    }
}

if (require.main === module) {
    seed().catch((error) => {
        console.error(`Falha ao executar seed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { seed };
