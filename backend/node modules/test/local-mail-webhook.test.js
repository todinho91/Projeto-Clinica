const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { createLocalMailbox, sameSecret } = require('../scripts/dev/local-mail-webhook');

test('comparação do segredo local não aceita valor vazio ou parcial', () => {
    assert.equal(sameSecret('', ''), false);
    assert.equal(sameSecret('abc', 'abcd'), false);
    assert.equal(sameSecret('segredo-local', 'segredo-local'), true);
});

test('caixa local exige bearer e mantém o link somente na interface local', async (t) => {
    const secret = 'fixture-local-mail-token-32-bytes-minimum';
    const server = createLocalMailbox(secret);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    const { port } = server.address();
    const endpoint = `http://127.0.0.1:${port}`;

    const unauthorized = await fetch(`${endpoint}/send`, { method: 'POST' });
    assert.equal(unauthorized.status, 401);

    const activationUrl = 'http://127.0.0.1:5500/aceitar-convite.html?token=fixture-secret-token';
    const accepted = await fetch(`${endpoint}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({
            to: 'profissional@example.test',
            variables: { clinicName: 'Clínica Teste', role: 'profissional', activationUrl }
        })
    });
    assert.equal(accepted.status, 202);
    assert.ok(accepted.headers.get('x-message-id'));
    assert.equal(await accepted.text(), '');

    const inbox = await (await fetch(endpoint)).text();
    assert.match(inbox, /profissional@example\.test/);
    assert.match(inbox, /fixture-secret-token/);
});
