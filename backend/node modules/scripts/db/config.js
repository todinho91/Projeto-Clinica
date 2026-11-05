const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

function required(name, env = process.env) {
    const value = env[name];
    if (!value || !String(value).trim()) {
        throw new Error(`Configuração obrigatória ausente: ${name}`);
    }
    return String(value).trim();
}

function parsePort(value, name) {
    if (!/^\d+$/.test(String(value))) {
        throw new Error(`${name} deve ser um número inteiro.`);
    }
    const port = Number(value);
    if (port < 1 || port > 65535) {
        throw new Error(`${name} deve estar entre 1 e 65535.`);
    }
    return port;
}

function loadDatabaseConfig(env = process.env, prefix = 'DB_') {
    return {
        host: required(`${prefix}HOST`, env),
        port: parsePort(env[`${prefix}PORT`] ?? '3306', `${prefix}PORT`),
        user: required(`${prefix}USER`, env),
        password: required(`${prefix}PASSWORD`, env),
        database: required(`${prefix}DATABASE`, env),
        charset: 'utf8mb4',
        timezone: 'Z'
    };
}

module.exports = { loadDatabaseConfig, parsePort, required };
