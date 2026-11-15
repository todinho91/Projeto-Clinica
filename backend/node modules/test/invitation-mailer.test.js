const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');

Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_USER: 'fixture_user', DB_PASSWORD: 'fixture_password',
    DB_DATABASE: 'fixture_database', JWT_SECRET: randomBytes(32).toString('hex'),
    MAIL_PROVIDER: 'disabled', APP_PUBLIC_ORIGIN: 'https://app.vitalis.example'
});

const { invitation } = require('../config/environment');
const mailer = require('../services/invitation-mailer');

function configureWebhook(t) {
    const original = { ...invitation };
    Object.assign(invitation, {
        mailProvider: 'webhook',
        mailApiUrl: 'https://mail.example.test/send',
        mailApiToken: 'fixture-token-not-a-real-secret',
        mailFrom: 'convites@example.test'
    });
    t.after(() => Object.assign(invitation, original));
}

const payload = {
    recipient: 'profissional@example.test', clinicName: 'Clínica Teste',
    role: 'profissional', token: 'a'.repeat(43)
};

test('provedor desativado diferencia convite criado de solicitação de envio', async () => {
    const result = await mailer.sendInvitation(payload);
    assert.deepEqual(result, {
        status: 'not_configured', delivered: false, reason: 'provider_not_configured'
    });
});

for (const statusCode of [200, 202]) {
    test(`HTTP ${statusCode} significa aceitação pelo provedor, não entrega`, async (t) => {
        configureWebhook(t);
        t.mock.method(globalThis, 'fetch', async () => ({
            ok: true,
            status: statusCode,
            headers: { get(name) { return name === 'x-message-id' ? 'provider-fixture-123' : null; } }
        }));
        const result = await mailer.sendInvitation(payload);
        assert.deepEqual(result, {
            status: 'accepted_by_provider',
            delivered: false,
            providerMessageId: 'provider-fixture-123'
        });
    });
}

test('rejeição HTTP do provedor é registrada como falha', async (t) => {
    configureWebhook(t);
    t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 422 }));
    const result = await mailer.sendInvitation(payload);
    assert.equal(result.status, 'failed');
    assert.equal(result.delivered, false);
    assert.equal(result.reason, 'provider_rejected');
});

test('falha de rede do provedor é registrada sem expor token', async (t) => {
    configureWebhook(t);
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('fixture unavailable'); });
    const result = await mailer.sendInvitation(payload);
    assert.deepEqual(result, {
        status: 'failed', delivered: false, reason: 'provider_unavailable'
    });
});
