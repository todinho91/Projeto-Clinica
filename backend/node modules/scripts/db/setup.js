const { migrate } = require('./migrate');
const { seed } = require('./seed');

async function setup() {
    await migrate();
    await seed();
    console.info('Banco de desenvolvimento preparado com dados sintéticos.');
}

if (require.main === module) {
    setup().catch((error) => {
        console.error(`Falha ao preparar banco: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { setup };
