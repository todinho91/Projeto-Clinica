const assert = require('node:assert/strict');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const core = require('../../../js/vitalis-client');

const root = path.join(__dirname, '..', '..', '..');

test('agenda exige papel de gestão e nunca envia clinica_id', async () => {
    const [page, main] = await Promise.all([
        fs.readFile(path.join(root, 'agenda.html'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'main.js'), 'utf8')
    ]);
    assert.equal(core.roleCanAccessPage('administrador', 'agenda.html'), true);
    assert.equal(core.roleCanAccessPage('secretaria', 'agenda.html'), true);
    assert.equal(core.roleCanAccessPage('profissional', 'agenda.html'), false);
    assert.equal(core.roleCanAccessPage('paciente', 'agenda.html'), false);
    assert.match(page, /id="consulta-form"/);
    assert.match(page, /id="agenda-filtros"/);
    const setup = main.slice(
        main.indexOf('async function setupAppointmentsPage()'),
        main.indexOf('async function setupPatientsPage()')
    );
    assert.match(setup, /requireClinicSession\('agenda\.html'\)/);
    assert.match(setup, /\/consultas\/horarios/);
    assert.match(setup, /\/consultas\/gestao/);
    assert.match(setup, /timeZone: context\.timezone/);
    assert.match(setup, /formatToParts\(new Date\(\)\)/);
    assert.doesNotMatch(setup, /clinica_id/);
});

test('troca de contexto descarta horários e listagens antigas', async () => {
    const main = await fs.readFile(path.join(root, 'js', 'main.js'), 'utf8');
    const setup = main.slice(
        main.indexOf('async function setupAppointmentsPage()'),
        main.indexOf('async function setupPatientsPage()')
    );
    assert.match(setup, /const slotsGate = VitalisCore\.createLatestRequestGate\(\)/);
    assert.match(setup, /const patientSearchGate = VitalisCore\.createLatestRequestGate\(\)/);
    assert.match(setup, /const listGate = VitalisCore\.createLatestRequestGate\(\)/);
    assert.match(setup, /slotsGate\.isCurrent\(ticket, key\)/);
    assert.match(setup, /listGate\.isCurrent\(ticket, key\)/);
    assert.match(setup, /const mutationLock = VitalisCore\.createOperationLock\(\)/);
    assert.match(setup, /!mutationLock\.tryBegin\(\)/);
    assert.match(setup, /patientSearchGate\.isCurrent\(ticket, query\)/);
    assert.match(setup, /patientSelect\.disabled = Boolean\(editingId\)/);
    assert.match(setup, /versao: editingVersion/);
    assert.match(setup, /localMinutes\(item\.fim_local\) - localMinutes\(item\.inicio_local\)/);
});

test('autoagendamento do paciente usa especialidade e slots no fuso da clínica', async () => {
    const [page, main] = await Promise.all([
        fs.readFile(path.join(root, 'dashboard-paciente.html'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'main.js'), 'utf8')
    ]);
    const setup = main.slice(
        main.indexOf('async function setupPacienteDashboard()'),
        main.indexOf('async function setupProfissionalDashboard()')
    );
    assert.match(page, /id="especialidade-select"/);
    assert.match(page, /id="horario-consulta"/);
    assert.match(setup, /apiRequest\('\/consultas\/contexto'\)/);
    assert.match(setup, /\/consultas\/horarios/);
    assert.match(setup, /VitalisCore\.appointmentPayload\([\s\S]*specialtySelect\.value/);
    assert.match(setup, /slotsGate\.isCurrent\(ticket, key\)/);
    assert.match(setup, /versao: Number\(appointment\.versao\)/);
    assert.doesNotMatch(setup, /apiRequest\('\/profissionais'\)/);
});

test('agenda mantém cartões responsivos em 390 e 360 px sem rolagem horizontal', async () => {
    const css = await fs.readFile(path.join(root, 'css', 'dashboard.css'), 'utf8');
    assert.match(css, /@media \(max-width: 1399\.98px\)[\s\S]*\.vitalis-appointments-page \.vitalis-appointment-grid[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    assert.match(css, /@media \(max-width: 767\.98px\)[\s\S]*\.vitalis-appointment-table[^}]*display: block/);
    assert.match(css, /\.vitalis-appointment-table td::before[^}]*content: attr\(data-label\)/);
    assert.match(css, /@media \(max-width: 389\.98px\)[\s\S]*\.vitalis-appointments-page \.vitalis-main/);
    assert.match(css, /\.vitalis-appointment-actions[^}]*flex-wrap: wrap/);
});

test('todas as páginas administrativas oferecem acesso compartilhado à agenda', async () => {
    const pages = [
        'dashboard-secretaria.html', 'pacientes.html', 'profissionais.html',
        'disponibilidade.html', 'especialidades.html', 'equipe.html',
        'configuracoes-clinica.html'
    ];
    for (const pageName of pages) {
        const page = await fs.readFile(path.join(root, pageName), 'utf8');
        assert.match(page, /href="agenda\.html"/, `${pageName} não contém o menu Agenda`);
    }
});
