const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');
const bcrypt = require('bcryptjs');
const seedData = require('../scripts/db/seed-data');
const {
    readSeedPassword,
    seedDatabase
} = require('../scripts/db/seeder');

class FakeSeedConnection {
    constructor() {
        this.ids = new Map();
        this.nextId = 1;
        this.commits = 0;
        this.rollbacks = 0;
    }

    async beginTransaction() {}
    async commit() { this.commits += 1; }
    async rollback() { this.rollbacks += 1; }

    keyFor(table, params) {
        const keys = {
            clinicas: () => params[1],
            usuarios: () => params[1],
            clinica_usuarios: () => `${params[0]}:${params[1]}`,
            especialidades: () => `${params[0]}:${params[1]}`,
            profissionais: () => `${params[0]}:${params[1]}`,
            profissional_especialidades: () => `${params[0]}:${params[1]}:${params[2]}`,
            pacientes: () => `${params[0]}:${params[1]}`,
            consultas: () => `${params[0]}:${params[2]}:${params[3]}`,
            documentos_clinicos: () => `${params[0]}:${params[3]}`,
            auditoria: () => `${params[0]}:${params[3]}`
        };
        return `${table}:${keys[table]()}`;
    }

    async execute(sql, params) {
        const match = sql.match(/INSERT(?: IGNORE)? INTO\s+([a-z_]+)/i);
        if (!match) throw new Error(`SQL inesperado no fake: ${sql}`);
        const table = match[1];
        const key = this.keyFor(table, params);
        if (!this.ids.has(key)) this.ids.set(key, this.nextId++);
        return [{ insertId: this.ids.get(key), affectedRows: 1 }];
    }
}

test('seed contém duas clínicas e somente e-mails reservados .test', () => {
    assert.equal(seedData.clinicas.length, 2);
    const emails = seedData.clinicas.flatMap((clinica) =>
        Object.values(clinica.usuarios).map((usuario) => usuario.email)
    );
    assert.equal(new Set(emails).size, emails.length);
    assert.ok(emails.every((email) => email.endsWith('@example.test')));
});

test('senha do seed é obrigatória e não possui valor padrão', () => {
    assert.throws(() => readSeedPassword({}), /SEED_PASSWORD é obrigatória/);
    assert.throws(() => readSeedPassword({ SEED_PASSWORD: 'curta' }), /pelo menos 12/);
});

test('seed armazena hash bcrypt e pode ser executado duas vezes sem duplicar chaves', async () => {
    const password = randomBytes(24).toString('base64url');
    const connection = new FakeSeedConnection();

    await seedDatabase({ connection, password, rounds: 4 });
    const countAfterFirstRun = connection.ids.size;
    await seedDatabase({ connection, password, rounds: 4 });

    assert.equal(connection.ids.size, countAfterFirstRun);
    assert.equal(connection.commits, 2);
    assert.equal(connection.rollbacks, 0);

    const hash = await bcrypt.hash(password, 4);
    assert.notEqual(hash, password);
    assert.equal(await bcrypt.compare(password, hash), true);
});
