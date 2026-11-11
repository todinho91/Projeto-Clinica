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

function parseCorsOrigins(value) {
    const origins = value.split(',').map((item) => item.trim()).filter(Boolean);
    if (origins.length === 0 || origins.includes('*')) {
        throw new Error('CORS_ORIGINS deve listar origens explícitas, sem curinga.');
    }
    return origins.map((origin) => {
        let parsed;
        try {
            parsed = new URL(origin);
        } catch {
            throw new Error(`Origem CORS inválida: ${origin}`);
        }
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
            throw new Error(`Origem CORS inválida: ${origin}`);
        }
        return origin;
    });
}

const corsOrigins = parseCorsOrigins(
    process.env.CORS_ORIGINS ?? 'http://127.0.0.1:5500,http://localhost:5500'
);

module.exports = {
    jwtSecret,
    port,
    corsOrigins,
    database: {
        host: required('DB_HOST'),
        user: required('DB_USER'),
        password: required('DB_PASSWORD'),
        database: required('DB_DATABASE')
    }
};
