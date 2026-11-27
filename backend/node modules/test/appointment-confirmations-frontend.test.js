const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.join(__dirname, '..', '..', '..');

async function loadConfirmationFrontend({ apiResults = [], confirm = true, popupFactory } = {}) {
    const source = await fs.readFile(path.join(root, 'js', 'main.js'), 'utf8');
    const start = source.indexOf('const pendingConfirmationRequests = new Set();');
    const end = source.indexOf('async function registerManualConfirmation', start);
    assert.notEqual(start, -1, 'início do fluxo de confirmação não encontrado');
    assert.notEqual(end, -1, 'fim do fluxo de confirmação não encontrado');

    const messages = [];
    const requests = [];
    const popups = [];
    const queue = [...apiResults];
    const context = {
        window: {
            VitalisConfirm: { ask: async () => confirm },
            open: (...args) => {
                const popup = popupFactory ? popupFactory(...args) : null;
                popups.push(popup);
                return popup;
            }
        },
        showMessage: (_element, message, type = 'danger') => messages.push({ message, type }),
        apiRequest: async (...args) => {
            requests.push(args);
            const next = queue.shift();
            if (next instanceof Error) throw next;
            return next;
        }
    };
    vm.createContext(context);
    vm.runInContext(
        `${source.slice(start, end)}\nthis.requestAppointmentConfirmation = requestAppointmentConfirmation;`,
        context
    );
    return { ...context, messages, requests, popups };
}

function popupDouble() {
    return {
        opener: {},
        closed: false,
        location: {
            replacedWith: null,
            replace(url) { this.replacedWith = url; }
        },
        close() { this.closed = true; }
    };
}

test('canal Painel Vitalis cria solicitação sem abrir popup', async () => {
    const frontend = await loadConfirmationFrontend({
        apiResults: [{ message: 'Solicitação disponível no painel.' }],
        popupFactory: () => { throw new Error('window.open não deveria ser chamado'); }
    });
    let refreshed = 0;

    await frontend.requestAppointmentConfirmation({
        id: 41,
        versao: 3,
        confirmacao_canal_recomendado: 'portal_vitalis'
    }, {}, async () => { refreshed += 1; });

    assert.equal(frontend.popups.length, 0);
    assert.equal(frontend.requests.length, 1);
    assert.equal(JSON.parse(frontend.requests[0][1].body).canal_esperado, 'portal_vitalis');
    assert.equal(frontend.messages.at(-1).type, 'success');
    assert.equal(refreshed, 1);
});

test('canal WhatsApp abre popup somente quando autorizado e usa a URL retornada', async () => {
    const popup = popupDouble();
    const frontend = await loadConfirmationFrontend({
        apiResults: [{
            message: 'Mensagem preparada.',
            whatsapp_url: 'https://wa.me/5500000000000?text=confirmacao'
        }],
        popupFactory: () => popup
    });

    await frontend.requestAppointmentConfirmation({
        id: 42,
        versao: 1,
        confirmacao_canal_recomendado: 'whatsapp'
    }, {});

    assert.equal(frontend.popups.length, 1);
    assert.equal(popup.opener, null);
    assert.equal(popup.location.replacedWith, 'https://wa.me/5500000000000?text=confirmacao');
    assert.equal(JSON.parse(frontend.requests[0][1].body).canal_esperado, 'whatsapp');
});

test('paciente sem canal autorizado não abre WhatsApp nem cria solicitação', async () => {
    const frontend = await loadConfirmationFrontend({
        popupFactory: () => { throw new Error('window.open não deveria ser chamado'); }
    });

    await frontend.requestAppointmentConfirmation({ id: 43, versao: 1 }, {});

    assert.equal(frontend.popups.length, 0);
    assert.equal(frontend.requests.length, 0);
    assert.equal(frontend.messages.at(-1).type, 'info');
    assert.match(frontend.messages.at(-1).message, /não possui um canal de confirmação autorizado/i);
});

test('falha libera a solicitação para nova tentativa nos canais portal e WhatsApp', async (t) => {
    for (const channel of ['portal_vitalis', 'whatsapp']) {
        await t.test(channel, async () => {
            const createdPopups = [];
            const frontend = await loadConfirmationFrontend({
                apiResults: [new Error('Falha temporária'), {
                    message: 'Solicitação recuperada.',
                    ...(channel === 'whatsapp' ? { whatsapp_url: 'https://wa.me/5500000000000' } : {})
                }],
                popupFactory: () => {
                    const popup = popupDouble();
                    createdPopups.push(popup);
                    return popup;
                }
            });
            const appointment = {
                id: channel === 'portal_vitalis' ? 44 : 45,
                versao: 2,
                confirmacao_canal_recomendado: channel
            };

            await frontend.requestAppointmentConfirmation(appointment, {});
            await frontend.requestAppointmentConfirmation(appointment, {});

            assert.equal(frontend.requests.length, 2, 'a segunda tentativa deve alcançar a API');
            assert.equal(frontend.messages.at(-1).type, 'success');
            if (channel === 'portal_vitalis') {
                assert.equal(frontend.popups.length, 0);
            } else {
                assert.equal(createdPopups[0].closed, true, 'popup da tentativa com falha deve fechar');
                assert.equal(createdPopups[1].location.replacedWith, 'https://wa.me/5500000000000');
            }
        });
    }
});
