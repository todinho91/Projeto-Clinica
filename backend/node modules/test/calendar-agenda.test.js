const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

Object.assign(process.env, {
    DB_HOST: '127.0.0.1', DB_USER: 'fixture_user', DB_PASSWORD: 'fixture_password',
    DB_DATABASE: 'fixture_database', PORT: '3000', JWT_SECRET: randomBytes(32).toString('hex')
});

const pool = require('../config/database');
const controller = require('../controllers/consultaController');
const router = require('../routes');

function response() {
    return {
        statusCode: null, body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

test('calendário limita cada leitura a no máximo 42 dias', () => {
    assert.equal(controller.calendarRangeDays('2032-01-01', '2032-02-11'), 42);
    assert.equal(controller.calendarRangeDays('2032-01-01', '2032-02-12'), null);
    assert.equal(controller.calendarRangeDays('2032-02-02', '2032-02-01'), null);
    assert.equal(controller.calendarRangeDays('inválida', '2032-02-01'), null);
});

test('rotas do calendário permitem gestão e profissional, mas recusam paciente', () => {
    for (const routePath of ['/consultas/calendario/contexto', '/consultas/calendario']) {
        const route = router.stack.find((layer) => layer.route?.path === routePath);
        assert.ok(route, `rota ausente: ${routePath}`);
        for (const role of ['administrador', 'secretaria', 'profissional']) {
            const res = response(); let next = false;
            route.route.stack[0].handle({ tenant: { role } }, res, () => { next = true; });
            assert.equal(next, true, `${role} deveria acessar ${routePath}`);
        }
        const res = response(); let next = false;
        route.route.stack[0].handle({ tenant: { role: 'paciente' } }, res, () => { next = true; });
        assert.equal(res.statusCode, 403); assert.equal(next, false);
    }
});

test('secretaria recebe somente eventos da clínica ativa e horários no fuso da clínica', async (t) => {
    let calendarSql; let calendarParams;
    t.mock.method(pool, 'execute', async (sql, params) => {
        if (/SELECT id, timezone FROM clinicas/.test(sql)) {
            return [[{ id: 11, timezone: 'America/Sao_Paulo' }]];
        }
        if (/SELECT cu\.papel, p\.id AS profissional_id/.test(sql)) {
            return [[{ papel: 'secretaria', profissional_id: null }]];
        }
        if (/SELECT c\.id, c\.inicio_em/.test(sql)) {
            calendarSql = sql; calendarParams = params;
            return [[{
                id: 91, inicio_em: '2032-05-10 12:00:00.000', fim_em: '2032-05-10 12:30:00.000',
                status: 'confirmada', versao: 2, paciente_id: 31, paciente_nome: 'Paciente Teste',
                profissional_id: 8, profissional_nome: 'Profissional Teste',
                especialidade_id: 5, especialidade_nome: 'Especialidade Teste'
            }]];
        }
        throw new Error(`SQL inesperado: ${sql}`);
    });
    const res = response();
    await controller.listCalendar({
        userId: 7, tenant: { clinicId: 11, role: 'secretaria' },
        query: { data_inicio: '2032-05-10', data_fim: '2032-05-16', status: 'todos' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.match(calendarSql, /WHERE c\.clinica_id = \?/);
    assert.match(calendarSql, /viewer\.usuario_id = \? AND viewer\.papel = \?/);
    assert.match(calendarSql, /clinic\.status = 'ativa'/);
    assert.match(calendarSql, /LIMIT 1001/);
    assert.deepEqual(calendarParams.slice(0, 3), [7, 'secretaria', 11]);
    assert.equal(res.body.consultas[0].inicio_local, '2032-05-10T09:00');
    assert.equal(res.body.consultas[0].fim_local, '2032-05-10T09:30');
    assert.equal(res.body.consultas[0].paciente_nome, 'Paciente Teste');
});

test('profissional não amplia a agenda manipulando o identificador do filtro', async (t) => {
    let calendarRead = false;
    t.mock.method(pool, 'execute', async (sql) => {
        if (/SELECT id, timezone FROM clinicas/.test(sql)) {
            return [[{ id: 11, timezone: 'America/Sao_Paulo' }]];
        }
        if (/SELECT cu\.papel, p\.id AS profissional_id/.test(sql)) {
            return [[{ papel: 'profissional', profissional_id: 8 }]];
        }
        if (/SELECT c\.id, c\.inicio_em/.test(sql)) calendarRead = true;
        return [[]];
    });
    const res = response();
    await controller.listCalendar({
        userId: 70, tenant: { clinicId: 11, role: 'profissional' },
        query: {
            data_inicio: '2032-05-10', data_fim: '2032-05-16', status: 'todos', profissional_id: '9'
        }
    }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(calendarRead, false);
});

test('contexto do médico oferece somente seu perfil e revalida o vínculo na consulta', async (t) => {
    let filterParams; let filterSql;
    t.mock.method(pool, 'execute', async (sql, params) => {
        if (/SELECT id, timezone FROM clinicas/.test(sql)) {
            return [[{ id: 11, timezone: 'America/Sao_Paulo' }]];
        }
        if (/SELECT cu\.papel, p\.id AS profissional_id/.test(sql)) {
            return [[{ papel: 'profissional', profissional_id: 8, profissional_nome: 'Profissional Teste' }]];
        }
        if (/SELECT DISTINCT p\.id AS profissional_id/.test(sql)) {
            filterSql = sql; filterParams = params;
            return [[{
                profissional_id: 8, profissional_nome: 'Profissional Teste',
                especialidade_id: 5, especialidade_nome: 'Especialidade Teste'
            }]];
        }
        throw new Error(`SQL inesperado: ${sql}`);
    });
    const res = response();
    await controller.calendarContext({
        userId: 70, tenant: { clinicId: 11, role: 'profissional' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.professional_id, 8);
    assert.deepEqual(res.body.profissionais, [{ id: 8, nome_exibicao: 'Profissional Teste' }]);
    assert.match(filterSql, /viewer\.usuario_id = \? AND viewer\.papel = \?/);
    assert.deepEqual(filterParams, [70, 'profissional', 11, 'profissional', 8]);
});

test('consulta do médico deriva seu perfil ativo e mantém defesa por usuário no SQL', async (t) => {
    let calendarParams; let calendarSql;
    t.mock.method(pool, 'execute', async (sql, params) => {
        if (/SELECT id, timezone FROM clinicas/.test(sql)) {
            return [[{ id: 11, timezone: 'America/Sao_Paulo' }]];
        }
        if (/SELECT cu\.papel, p\.id AS profissional_id/.test(sql)) {
            return [[{ papel: 'profissional', profissional_id: 8 }]];
        }
        if (/SELECT c\.id, c\.inicio_em/.test(sql)) {
            calendarSql = sql; calendarParams = params; return [[]];
        }
        throw new Error(`SQL inesperado: ${sql}`);
    });
    const res = response();
    await controller.listCalendar({
        userId: 70, tenant: { clinicId: 11, role: 'profissional' },
        query: { data_inicio: '2032-05-10', data_fim: '2032-05-16', status: 'todos' }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.match(calendarSql, /\? <> 'profissional' OR p\.usuario_id = \?/);
    assert.equal(calendarParams[7], 8);
    assert.equal(calendarParams.at(-2), 'profissional');
    assert.equal(calendarParams.at(-1), 70);
});

test('interface premium preserva menu, três visões, detalhes, mobile e confirmação autorizada', async () => {
    const root = path.resolve(__dirname, '..', '..', '..');
    const [page, main, css, client] = await Promise.all([
        fs.readFile(path.join(root, 'calendario.html'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'main.js'), 'utf8'),
        fs.readFile(path.join(root, 'css', 'dashboard.css'), 'utf8'),
        fs.readFile(path.join(root, 'js', 'vitalis-client.js'), 'utf8')
    ]);
    const setup = main.slice(main.indexOf('async function setupCalendarPage()'), main.indexOf('async function setupAppointmentsPage()'));
    for (const view of ['day', 'week', 'month']) assert.match(page, new RegExp(`data-calendar-view="${view}"`));
    for (const id of ['calendar-previous', 'calendar-today', 'calendar-next', 'calendar-professional', 'calendar-specialty', 'calendar-status-filter']) {
        assert.match(page, new RegExp(`id="${id}"`));
    }
    for (const href of [
        'dashboard-secretaria.html', 'pacientes.html', 'profissionais.html', 'disponibilidade.html',
        'especialidades.html', 'agenda.html', 'calendario.html', 'equipe.html', 'configuracoes-clinica.html'
    ]) assert.match(page, new RegExp(`href="${href}"`));
    assert.match(page, /href="calendario\.html" aria-current="page"/);
    assert.match(page, /id="calendar-selection"/);
    assert.match(page, /id="calendar-selection-list"/);
    assert.match(page, /role="grid"/);
    assert.match(setup, /ArrowLeft/); assert.match(setup, /ArrowRight/); assert.match(setup, /\.focus\(\)/);
    assert.match(setup, /createLatestRequestGate/);
    assert.match(setup, /window\.setInterval[\s\S]*30000/);
    assert.match(setup, /data\.consultas/);
    assert.match(setup, /item\.inicio_local/);
    assert.match(setup, /dayAppointments\.slice\(0, 3\)/);
    assert.match(setup, /\+ \$\{dayAppointments\.length - 3\} consultas/);
    assert.match(setup, /vitalis-calendar-markers/);
    assert.match(setup, /openAppointment\(item\)/);
    assert.match(setup, /showSelection\(items/);
    assert.match(setup, /document\.createElement\('button'\)/);
    assert.doesNotMatch(setup, /clinica_id/);
    assert.match(setup, /requestWhatsAppConfirmation\(item, status, loadCalendar\)/);
    assert.doesNotMatch(setup, /wa\.me|estado_entrega\s*=\s*['"]entrega_confirmada/i);
    assert.match(client, /'calendario\.html': \['administrador', 'secretaria', 'profissional'\]/);
    assert.match(css, /\.vitalis-calendar-week, \.vitalis-calendar-month[^}]*repeat\(7/);
    assert.match(css, /\.vitalis-calendar-month \.vitalis-calendar-day[^}]*min-height: 112px/);
    assert.match(css, /@media \(max-width: 991\.98px\)[\s\S]*\.vitalis-calendar-week[^}]*repeat\(2/);
    assert.match(css, /@media \(max-width: 767\.98px\)[\s\S]*\.vitalis-calendar-month[^}]*repeat\(7/);
    assert.match(css, /@media \(max-width: 767\.98px\)[\s\S]*\.vitalis-calendar-month \.vitalis-calendar-events[^}]*display: none/);
    assert.match(css, /@media \(max-width: 767\.98px\)[\s\S]*\.vitalis-calendar-month \.vitalis-calendar-markers[^}]*display: flex/);
    assert.match(css, /\.vitalis-calendar-selection-list/);
});
