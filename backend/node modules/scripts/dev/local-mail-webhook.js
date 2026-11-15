const http = require('node:http');
const { randomUUID, timingSafeEqual } = require('node:crypto');

const HOST = '127.0.0.1';

function sameSecret(received, expected) {
    const left = Buffer.from(received || '');
    const right = Buffer.from(expected || '');
    return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function createLocalMailbox(secret) {
    if (typeof secret !== 'string' || secret.length < 32) {
        throw new Error('LOCAL_MAIL_WEBHOOK_TOKEN deve ter pelo menos 32 caracteres.');
    }
    let latest = null;
    return http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/send') {
            const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '');
            if (!sameSecret(bearer, secret)) {
                res.writeHead(401).end('Unauthorized');
                return;
            }
            let raw = '';
            req.on('data', (chunk) => {
                raw += chunk;
                if (raw.length > 64 * 1024) req.destroy();
            });
            req.on('end', () => {
                try {
                    const payload = JSON.parse(raw);
                    const activationUrl = new URL(payload?.variables?.activationUrl);
                    if (!['http:', 'https:'].includes(activationUrl.protocol)) throw new Error('invalid URL');
                    latest = {
                        to: String(payload.to || ''),
                        clinic: String(payload.variables?.clinicName || ''),
                        role: String(payload.variables?.role || ''),
                        activationUrl: activationUrl.toString(),
                        receivedAt: new Date().toISOString()
                    };
                    res.writeHead(202, { 'x-message-id': randomUUID() }).end();
                } catch {
                    res.writeHead(400).end('Invalid payload');
                }
            });
            return;
        }
        if (req.method === 'GET' && req.url === '/') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            const content = latest
                ? `<p><strong>Para:</strong> ${escapeHtml(latest.to)}</p>
                   <p><strong>Clínica:</strong> ${escapeHtml(latest.clinic)}</p>
                   <p><strong>Papel:</strong> ${escapeHtml(latest.role)}</p>
                   <p><strong>Recebido:</strong> ${escapeHtml(latest.receivedAt)}</p>
                   <p><a href="${escapeHtml(latest.activationUrl)}">Aceitar convite</a></p>`
                : '<p>Nenhum convite recebido nesta execução.</p>';
            res.end(`<!doctype html><html lang="pt-BR"><meta charset="utf-8">
                <meta name="robots" content="noindex"><title>Caixa local Vitalis</title>
                <body><main><h1>Caixa local de convites</h1>${content}</main></body></html>`);
            return;
        }
        res.writeHead(404).end('Not found');
    });
}

if (require.main === module) {
    const port = Number(process.env.LOCAL_MAIL_WEBHOOK_PORT || 3100);
    const server = createLocalMailbox(process.env.LOCAL_MAIL_WEBHOOK_TOKEN);
    server.listen(port, HOST, () => {
        console.log(`Caixa local disponível em http://${HOST}:${port} (conteúdo mantido somente em memória).`);
    });
}

module.exports = { createLocalMailbox, sameSecret };
