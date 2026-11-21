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

function publicOrigin(value) {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error('APP_PUBLIC_ORIGIN inválida.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== value) {
        throw new Error('APP_PUBLIC_ORIGIN deve ser uma origem HTTP(S), sem caminho.');
    }
    const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (parsed.protocol !== 'https:' && !localHosts.has(parsed.hostname)) {
        throw new Error('APP_PUBLIC_ORIGIN deve usar HTTPS fora do ambiente local.');
    }
    return value;
}

const mailProvider = process.env.MAIL_PROVIDER ?? 'disabled';
if (!['disabled', 'webhook'].includes(mailProvider)) {
    throw new Error('MAIL_PROVIDER deve ser disabled ou webhook.');
}
const webhookMail = mailProvider === 'webhook';
const mailApiUrl = webhookMail ? required('MAIL_API_URL') : null;
if (webhookMail) {
    let parsedMailUrl;
    try { parsedMailUrl = new URL(mailApiUrl); } catch { throw new Error('MAIL_API_URL inválida.'); }
    if (!['http:', 'https:'].includes(parsedMailUrl.protocol)) throw new Error('MAIL_API_URL inválida.');
}
const ttlHours = Number(process.env.INVITATION_TTL_HOURS ?? '48');
if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) {
    throw new Error('INVITATION_TTL_HOURS deve ser um inteiro entre 1 e 168.');
}
const confirmationTtlHours = Number(process.env.CONFIRMATION_TTL_HOURS ?? '24');
if (!Number.isInteger(confirmationTtlHours) || confirmationTtlHours < 1 || confirmationTtlHours > 168) {
    throw new Error('CONFIRMATION_TTL_HOURS deve ser um inteiro entre 1 e 168.');
}

module.exports = {
    jwtSecret,
    port,
    corsOrigins,
    invitation: {
        publicOrigin: publicOrigin(process.env.APP_PUBLIC_ORIGIN ?? 'http://127.0.0.1:5500'),
        mailProvider,
        mailApiUrl,
        mailApiToken: webhookMail ? required('MAIL_API_TOKEN') : null,
        mailFrom: webhookMail ? required('MAIL_FROM') : null,
        ttlHours
    },
    confirmation: {
        publicOrigin: publicOrigin(process.env.APP_PUBLIC_ORIGIN ?? 'http://127.0.0.1:5500'),
        ttlHours: confirmationTtlHours
    },
    database: {
        host: required('DB_HOST'),
        user: required('DB_USER'),
        password: required('DB_PASSWORD'),
        database: required('DB_DATABASE')
    }
};
