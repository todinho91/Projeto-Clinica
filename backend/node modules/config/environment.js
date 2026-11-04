const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env'), quiet: true });

function required(name) {
    const value = process.env[name];
    if (!value || !value.trim()) {
        throw new Error(`Configuração obrigatória ausente: ${name}`);
    }
    return value;
}

const jwtSecret = required('JWT_SECRET');
if (Buffer.byteLength(jwtSecret.trim(), 'utf8') < 32) {
    throw new Error('JWT_SECRET deve ter pelo menos 32 bytes.');
}

const rawPort = process.env.PORT ?? '3000';
const port = Number(rawPort);
if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error('PORT deve ser um inteiro entre 1 e 65535.');
}

module.exports = {
    jwtSecret,
    port,
    database: {
        host: required('DB_HOST'),
        user: required('DB_USER'),
        password: required('DB_PASSWORD'),
        database: required('DB_DATABASE')
    }
};
