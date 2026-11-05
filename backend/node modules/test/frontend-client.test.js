const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const core = require('../../../js/vitalis-client');

class MemoryStorage {
    constructor() { this.values = new Map(); }
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(key, String(value)); }
    removeItem(key) { this.values.delete(key); }
}

test('sessão separa token de identidade do token da clínica e limpa ambos', () => {
    const session = core.createSession(new MemoryStorage());
    session.saveIdentity({
        token: 'identity-fixture',
        usuario: { id: 1, nome: 'Pessoa Demo' },
        clinicas: [{ id: 10, nome: 'Clínica Demo', papel: 'paciente' }]
    });
    session.saveClinic({
        token: 'clinic-fixture',
        clinica: { id: 10, nome: 'Clínica Demo', papel: 'paciente' }
    });

    assert.equal(session.identityToken, 'identity-fixture');
    assert.equal(session.clinicToken, 'clinic-fixture');
    assert.equal(session.activeClinic.id, 10);
    session.clear();
    assert.equal(session.identityToken, null);
    assert.equal(session.clinicToken, null);
});

test('papéis são direcionados somente aos painéis permitidos', () => {
    assert.equal(core.dashboardForRole('administrador'), 'dashboard-secretaria.html');
    assert.equal(core.dashboardForRole('secretaria'), 'dashboard-secretaria.html');
    assert.equal(core.dashboardForRole('profissional'), 'dashboard-medico.html');
    assert.equal(core.dashboardForRole('paciente'), 'dashboard-paciente.html');
    assert.equal(core.roleCanAccessPage('paciente', 'dashboard-medico.html'), false);
    assert.equal(core.roleCanAccessPage('profissional', 'dashboard-medico.html'), true);
});

test('agendamento converte o horário local com fuso para intervalo UTC', () => {
    assert.deepEqual(
        core.appointmentPayload('2032-01-01T10:00:00-03:00', 45, '8'),
        {
            profissional_id: 8,
            inicio_em: '2032-01-01T13:00:00.000Z',
            fim_em: '2032-01-01T13:45:00.000Z'
        }
    );
    assert.throws(() => core.appointmentPayload('', 45, 8), /inválidos/);
});

test('resumo conta somente datas válidas e status compatíveis com cada indicador', () => {
    const summary = core.dashboardSummary(
        [{ id: 1 }, { id: 2 }],
        [
            { inicio_em: '2032-01-01T09:00:00.000Z', status: 'realizada' },
            { inicio_em: '2032-01-01T10:00:00.000Z', status: 'cancelada' },
            { inicio_em: '2032-01-01T16:00:00.000Z', status: 'confirmada' },
            { inicio_em: '2032-01-02T09:00:00.000Z', status: 'agendada' },
            { inicio_em: '2032-01-02T10:00:00.000Z', status: 'nao_compareceu' },
            { inicio_em: 'data-inválida', status: 'agendada' }
        ],
        new Date('2032-01-01T12:00:00.000Z')
    );

    assert.deepEqual(summary, { professionals: 2, today: 2, upcoming: 2 });
});

test('agenda resumida ordena próximos horários e remove dados do paciente', () => {
    const agenda = core.dashboardAgenda([
        { id: 3, inicio_em: '2032-01-02T14:00:00.000Z', fim_em: '2032-01-02T15:00:00.000Z', status: 'confirmada', nome_profissional: 'Profissional B', nome_paciente: 'Não exibir' },
        { id: 1, inicio_em: '2032-01-02T13:00:00.000Z', fim_em: '2032-01-02T14:00:00.000Z', status: 'agendada', nome_profissional: 'Profissional A', paciente_id: 99 },
        { id: 2, inicio_em: '2032-01-02T12:00:00.000Z', fim_em: '2032-01-02T13:00:00.000Z', status: 'realizada', nome_profissional: 'Profissional C' }
    ], new Date('2032-01-02T10:00:00.000Z'));

    assert.deepEqual(agenda.map((item) => item.id), [1, 3]);
    assert.equal('nome_paciente' in agenda[0], false);
    assert.equal('paciente_id' in agenda[0], false);
});

test('frontend usa sessionStorage e inclui o fluxo de seleção de clínica', async () => {
    const root = path.join(__dirname, '..', '..', '..');
    const main = await fs.readFile(path.join(root, 'js', 'main.js'), 'utf8');
    const selection = await fs.readFile(path.join(root, 'select-clinic.html'), 'utf8');
    assert.match(main, /window\.sessionStorage/);
    assert.doesNotMatch(main, /localStorage/);
    assert.match(main, /\/auth\/select-clinic/);
    assert.match(selection, /id="clinica-select"/);
});
