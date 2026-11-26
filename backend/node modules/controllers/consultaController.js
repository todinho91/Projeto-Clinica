const pool = require('../config/database');
const { mysqlUtc, utcToLocal, zonedLocalToUtc } = require('../support/clinic-time');
const { revokePrepared } = require('./confirmacaoConsultaController');

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(['agendada', 'confirmada', 'realizada', 'cancelada', 'nao_compareceu']);
const ACTIVE = new Set(['agendada', 'confirmada']);
const TRANSITIONS = new Map([
    ['agendada', new Set(['confirmada', 'realizada', 'cancelada', 'nao_compareceu'])],
    ['confirmada', new Set(['realizada', 'cancelada', 'nao_compareceu'])],
    ['realizada', new Set()], ['cancelada', new Set()], ['nao_compareceu', new Set()]
]);

function logFailure(operation, error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code : 'UNEXPECTED';
    console.error('[consultas] operation_failed', { operation, code });
}

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function boundedInteger(value, fallback, max) {
    if (value === undefined || value === null || value === '') return fallback;
    if (!/^[1-9]\d*$/.test(String(value))) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed <= max ? parsed : null;
}

function calendarRangeDays(startDate, endDate) {
    if (!DATE.test(startDate || '') || !DATE.test(endDate || '') || endDate < startDate) return null;
    const start = new Date(`${startDate}T00:00:00Z`);
    const end = new Date(`${endDate}T00:00:00Z`);
    const days = Math.floor((end - start) / 86400000) + 1;
    return Number.isInteger(days) && days >= 1 && days <= 42 ? days : null;
}

function appointmentPeriod(body = {}, timeZone, now = new Date()) {
    let start;
    let end;
    if (typeof body.inicio_local === 'string') {
        const duration = Number(body.duracao_minutos);
        if (!Number.isInteger(duration) || duration < 15 || duration > 240 || duration % 5) return null;
        start = zonedLocalToUtc(body.inicio_local, timeZone);
        end = start ? new Date(start.getTime() + duration * 60000) : null;
    } else {
        start = typeof body.inicio_em === 'string' ? new Date(body.inicio_em) : null;
        end = typeof body.fim_em === 'string' ? new Date(body.fim_em) : null;
    }
    if (!start || !end || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
    const duration = (end - start) / 60000;
    if (duration < 15 || duration > 240 || duration % 5 || start <= now) return null;
    return { start, end, duration };
}

function localPeriod(period, timeZone) {
    const start = utcToLocal(period.start, timeZone);
    const end = utcToLocal(period.end, timeZone);
    if (!start || !end || start.slice(0, 10) !== end.slice(0, 10)) return null;
    const minutes = (value) => Number(value.slice(11, 13)) * 60 + Number(value.slice(14, 16));
    return {
        day: new Date(`${start.slice(0, 10)}T00:00:00Z`).getUTCDay(),
        date: start.slice(0, 10), startMinute: minutes(start), endMinute: minutes(end)
    };
}

function periodFitsWeekly(intervals, local) {
    const values = intervals.map((item) => ({
        type: item.tipo,
        start: Number(String(item.inicio).slice(0, 2)) * 60 + Number(String(item.inicio).slice(3, 5)),
        end: Number(String(item.fim).slice(0, 2)) * 60 + Number(String(item.fim).slice(3, 5))
    }));
    return values.some((item) => item.type === 'atendimento'
        && local.startMinute >= item.start && local.endMinute <= item.end)
        && !values.some((item) => item.type === 'descanso'
            && local.startMinute < item.end && local.endMinute > item.start);
}

function canTransition(from, to) {
    return STATUSES.has(to) && Boolean(TRANSITIONS.get(from)?.has(to));
}

function transitionAllowedAt(appointment, target, now = new Date()) {
    const utcDate = (value) => {
        if (value instanceof Date) return value;
        const text = String(value).replace(' ', 'T');
        return new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(text) ? text : `${text}Z`);
    };
    const start = utcDate(appointment?.inicio_em);
    const end = utcDate(appointment?.fim_em);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
        || !Number.isFinite(now.getTime())) return false;
    if (target === 'realizada') return now >= start;
    if (target === 'nao_compareceu') return now >= end;
    if (target === 'confirmada' || target === 'cancelada') return now < end;
    return false;
}

async function activeOperator(connection, req) {
    const [rows] = await connection.execute(`
        SELECT cu.papel FROM clinica_usuarios cu
        JOIN usuarios u ON u.id = cu.usuario_id AND u.status = 'ativo'
        WHERE cu.clinica_id = ? AND cu.usuario_id = ? AND cu.papel = ?
          AND cu.status = 'ativo' AND cu.sessao_versao = ? LIMIT 1 FOR UPDATE
    `, [req.tenant.clinicId, req.userId, req.tenant.role, req.auth?.membershipVersion]);
    return rows[0]?.papel ?? null;
}

async function activePracticeOwner(connection, req) {
    if (!req.workspaceOwner) return null;
    const [rows] = await connection.execute(`
        SELECT p.id AS profissional_id
        FROM consultorios_profissionais cp
        JOIN identidades_profissionais ip ON ip.usuario_id = cp.titular_usuario_id
          AND ip.status_verificacao = 'verificada'
        JOIN clinicas c ON c.id = cp.clinica_id AND c.status = 'ativa'
        JOIN clinica_usuarios cu ON cu.clinica_id = cp.clinica_id
          AND cu.usuario_id = cp.titular_usuario_id
          AND cu.papel = 'profissional' AND cu.status = 'ativo'
        JOIN usuarios u ON u.id = cp.titular_usuario_id AND u.status = 'ativo'
        JOIN profissionais p ON p.clinica_id = cp.clinica_id
          AND p.usuario_id = cp.titular_usuario_id AND p.status = 'ativo'
        WHERE cp.clinica_id = ? AND cp.titular_usuario_id = ? AND cp.status = 'ativo'
          AND cu.sessao_versao = ?
        LIMIT 1 FOR UPDATE
    `, [req.tenant.clinicId, req.userId, req.auth?.membershipVersion]);
    return rows[0] ?? null;
}

async function activeClinic(executor, clinicId, lock = false) {
    const [rows] = await executor.execute(`
        SELECT id, timezone FROM clinicas WHERE id = ? AND status = 'ativa'
        LIMIT 1 ${lock ? 'FOR UPDATE' : ''}
    `, [clinicId]);
    return rows[0] ?? null;
}

async function activePatient(connection, req, requestedId, lock = false) {
    const [rows] = await connection.execute(`
        SELECT id, nome FROM pacientes WHERE clinica_id = ? AND status = 'ativo'
          AND ((? = 'paciente' AND usuario_id = ?) OR (? <> 'paciente' AND id = ?))
        LIMIT 1 ${lock ? 'FOR UPDATE' : ''}
    `, [req.tenant.clinicId, req.tenant.role, req.userId, req.tenant.role, requestedId]);
    return rows[0] ?? null;
}

async function activeProfessional(executor, clinicId, professionalId, specialtyId, lock = false) {
    const [rows] = await executor.execute(`
        SELECT p.id, p.nome_exibicao, e.id AS especialidade_id, e.nome AS especialidade_nome
        FROM profissionais p
        JOIN clinica_usuarios cu ON cu.clinica_id = p.clinica_id AND cu.usuario_id = p.usuario_id
          AND cu.papel = 'profissional' AND cu.status = 'ativo'
        JOIN usuarios u ON u.id = p.usuario_id AND u.status = 'ativo'
        JOIN profissional_especialidades pe ON pe.clinica_id = p.clinica_id AND pe.profissional_id = p.id
        JOIN especialidades e ON e.clinica_id = pe.clinica_id AND e.id = pe.especialidade_id
          AND e.status = 'ativa'
        WHERE p.clinica_id = ? AND p.id = ? AND p.status = 'ativo'
          AND (? IS NULL OR e.id = ?)
        ORDER BY e.nome, e.id LIMIT 1 ${lock ? 'FOR UPDATE' : ''}
    `, [clinicId, professionalId, specialtyId, specialtyId]);
    return rows[0] ?? null;
}

async function weeklyIntervals(executor, clinicId, professionalId, day) {
    const [rows] = await executor.execute(`
        SELECT tipo, TIME_FORMAT(inicio_local, '%H:%i') AS inicio,
               TIME_FORMAT(fim_local, '%H:%i') AS fim
        FROM disponibilidades_profissional
        WHERE clinica_id = ? AND profissional_id = ? AND dia_semana = ? AND status = 'ativo'
        ORDER BY inicio_local, fim_local
    `, [clinicId, professionalId, day]);
    return rows;
}

async function validateReservation(executor, clinicId, professionalId, period, timeZone, ignoredId = 0) {
    const local = localPeriod(period, timeZone);
    if (!local) return { ok: false, reason: 'periodo' };
    const intervals = await weeklyIntervals(executor, clinicId, professionalId, local.day);
    if (!periodFitsWeekly(intervals, local)) return { ok: false, reason: 'grade' };
    const [blocks] = await executor.execute(`
        SELECT id FROM bloqueios_profissional
        WHERE clinica_id = ? AND profissional_id = ? AND status = 'ativo'
          AND inicio_em < ? AND fim_em > ? LIMIT 1
    `, [clinicId, professionalId, mysqlUtc(period.end), mysqlUtc(period.start)]);
    if (blocks.length) return { ok: false, reason: 'bloqueio' };
    const [appointments] = await executor.execute(`
        SELECT id FROM consultas
        WHERE clinica_id = ? AND profissional_id = ? AND status IN ('agendada', 'confirmada')
          AND id <> ? AND inicio_em < ? AND fim_em > ? LIMIT 1
    `, [clinicId, professionalId, ignoredId, mysqlUtc(period.end), mysqlUtc(period.start)]);
    return appointments.length ? { ok: false, reason: 'consulta' } : { ok: true };
}

async function audit(connection, req, action, appointmentId, metadata = {}) {
    await connection.execute(`
        INSERT INTO auditoria (clinica_id, usuario_id, acao, entidade_tipo, entidade_id, metadados)
        VALUES (?, ?, ?, 'consulta', ?, ?)
    `, [req.tenant.clinicId, req.userId, action, appointmentId, JSON.stringify(metadata)]);
}

async function history(connection, req, appointment, action, previous = null, metadata = {}) {
    await connection.execute(`
        INSERT INTO consultas_historico (
            clinica_id, consulta_id, versao, acao, status_anterior, status_novo,
            inicio_anterior, fim_anterior, inicio_novo, fim_novo, alterado_por_usuario_id, metadados
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        req.tenant.clinicId, appointment.id, appointment.versao, action,
        previous?.status ?? null, appointment.status, previous?.inicio_em ?? null,
        previous?.fim_em ?? null, appointment.inicio_em, appointment.fim_em,
        req.userId, JSON.stringify(metadata)
    ]);
}

async function lockedAppointment(connection, req, appointmentId) {
    const [rows] = await connection.execute(`
        SELECT c.id, c.paciente_id, c.profissional_id, c.especialidade_id,
               c.inicio_em, c.fim_em, c.status, c.versao,
               p.usuario_id AS profissional_usuario_id, p.status AS profissional_status,
               pa.usuario_id AS paciente_usuario_id
        FROM consultas c
        JOIN profissionais p ON p.clinica_id = c.clinica_id AND p.id = c.profissional_id
        JOIN pacientes pa ON pa.clinica_id = c.clinica_id AND pa.id = c.paciente_id
        WHERE c.clinica_id = ? AND c.id = ? LIMIT 1 FOR UPDATE
    `, [req.tenant.clinicId, appointmentId]);
    return rows[0] ?? null;
}

function accessible(req, appointment) {
    if (['administrador', 'secretaria'].includes(req.tenant.role)) return true;
    if (req.tenant.role === 'profissional') return Number(appointment.profissional_usuario_id) === req.userId;
    return req.tenant.role === 'paciente' && Number(appointment.paciente_usuario_id) === req.userId;
}

async function rollback(connection, res, status, error) {
    await connection.rollback();
    return res.status(status).json({ error });
}

exports.context = async (req, res) => {
    try {
        const clinic = await activeClinic(pool, req.tenant.clinicId);
        if (!clinic) return res.status(409).json({ error: 'Clínica ativa não disponível.' });
        const [rows] = await pool.execute(`
            SELECT e.id AS especialidade_id, e.nome AS especialidade_nome,
                   p.id AS profissional_id, p.nome_exibicao AS profissional_nome
            FROM especialidades e
            JOIN profissional_especialidades pe ON pe.clinica_id = e.clinica_id AND pe.especialidade_id = e.id
            JOIN profissionais p ON p.clinica_id = pe.clinica_id AND p.id = pe.profissional_id
              AND p.status = 'ativo'
            JOIN clinica_usuarios cu ON cu.clinica_id = p.clinica_id AND cu.usuario_id = p.usuario_id
              AND cu.papel = 'profissional' AND cu.status = 'ativo'
            JOIN usuarios u ON u.id = p.usuario_id AND u.status = 'ativo'
            WHERE e.clinica_id = ? AND e.status = 'ativa'
            ORDER BY e.nome, p.nome_exibicao, p.id
        `, [req.tenant.clinicId]);
        const result = [];
        const map = new Map();
        rows.forEach((row) => {
            const id = Number(row.especialidade_id);
            if (!map.has(id)) {
                const item = { id, nome: row.especialidade_nome, profissionais: [] };
                map.set(id, item); result.push(item);
            }
            map.get(id).profissionais.push({ id: Number(row.profissional_id), nome_exibicao: row.profissional_nome });
        });
        return res.status(200).json({ timezone: clinic.timezone, especialidades: result });
    } catch (error) {
        logFailure('context', error);
        return res.status(500).json({ error: 'Erro ao carregar opções de agendamento.' });
    }
};

exports.calendarContext = async (req, res) => {
    const { clinicId, role } = req.tenant;
    try {
        const clinic = await activeClinic(pool, clinicId);
        if (!clinic) return res.status(409).json({ error: 'Clínica ativa não disponível.' });
        const [actors] = await pool.execute(`
            SELECT cu.papel, p.id AS profissional_id, p.nome_exibicao AS profissional_nome
            FROM clinica_usuarios cu
            JOIN usuarios u ON u.id = cu.usuario_id AND u.status = 'ativo'
            LEFT JOIN profissionais p ON p.clinica_id = cu.clinica_id AND p.usuario_id = cu.usuario_id
              AND p.status = 'ativo'
            WHERE cu.clinica_id = ? AND cu.usuario_id = ? AND cu.papel = ?
              AND cu.status = 'ativo' LIMIT 1
        `, [clinicId, req.userId, role]);
        const actor = actors[0];
        if (!actor || (role === 'profissional' && !actor.profissional_id)) {
            return res.status(403).json({ error: 'Vínculo profissional ativo não autorizado.' });
        }
        const [rows] = await pool.execute(`
            SELECT DISTINCT p.id AS profissional_id, p.nome_exibicao AS profissional_nome,
                e.id AS especialidade_id, e.nome AS especialidade_nome
            FROM profissionais p
            JOIN clinicas clinic ON clinic.id = p.clinica_id AND clinic.status = 'ativa'
            JOIN clinica_usuarios viewer ON viewer.clinica_id = p.clinica_id
              AND viewer.usuario_id = ? AND viewer.papel = ? AND viewer.status = 'ativo'
            JOIN usuarios viewer_user ON viewer_user.id = viewer.usuario_id AND viewer_user.status = 'ativo'
            JOIN clinica_usuarios cu ON cu.clinica_id = p.clinica_id AND cu.usuario_id = p.usuario_id
              AND cu.papel = 'profissional' AND cu.status = 'ativo'
            JOIN usuarios u ON u.id = p.usuario_id AND u.status = 'ativo'
            LEFT JOIN profissional_especialidades pe ON pe.clinica_id = p.clinica_id
              AND pe.profissional_id = p.id
            LEFT JOIN especialidades e ON e.clinica_id = pe.clinica_id AND e.id = pe.especialidade_id
              AND e.status = 'ativa'
            WHERE p.clinica_id = ? AND p.status = 'ativo'
              AND (? <> 'profissional' OR p.id = ?)
            ORDER BY p.nome_exibicao, p.id, e.nome, e.id
        `, [req.userId, role, clinicId, role, actor.profissional_id || 0]);
        const professionals = new Map();
        const specialties = new Map();
        rows.forEach((row) => {
            const professionalId = Number(row.profissional_id);
            const specialtyId = row.especialidade_id ? Number(row.especialidade_id) : null;
            if (!professionals.has(professionalId)) {
                professionals.set(professionalId, {
                    id: professionalId, nome_exibicao: row.profissional_nome
                });
            }
            if (specialtyId && !specialties.has(specialtyId)) {
                specialties.set(specialtyId, { id: specialtyId, nome: row.especialidade_nome });
            }
        });
        return res.status(200).json({
            timezone: clinic.timezone,
            today: utcToLocal(new Date(), clinic.timezone).slice(0, 10),
            role,
            professional_id: role === 'profissional' ? Number(actor.profissional_id) : null,
            profissionais: [...professionals.values()],
            especialidades: [...specialties.values()]
        });
    } catch (error) {
        logFailure('calendar_context', error);
        return res.status(500).json({ error: 'Erro ao carregar filtros do calendário.' });
    }
};

exports.listCalendar = async (req, res) => {
    const { clinicId, role } = req.tenant;
    const startDate = req.query?.data_inicio;
    const endDate = req.query?.data_fim;
    const status = req.query?.status || 'todos';
    const requestedProfessional = req.query?.profissional_id
        ? positiveId(req.query.profissional_id) : null;
    const specialtyId = req.query?.especialidade_id ? positiveId(req.query.especialidade_id) : null;
    if (!calendarRangeDays(startDate, endDate)
        || (status !== 'todos' && !STATUSES.has(status))
        || (req.query?.profissional_id && !requestedProfessional)
        || (req.query?.especialidade_id && !specialtyId)) {
        return res.status(400).json({ error: 'Período ou filtros do calendário inválidos.' });
    }
    try {
        const clinic = await activeClinic(pool, clinicId);
        if (!clinic) return res.status(409).json({ error: 'Clínica ativa não disponível.' });
        const [actors] = await pool.execute(`
            SELECT cu.papel, p.id AS profissional_id
            FROM clinica_usuarios cu
            JOIN usuarios u ON u.id = cu.usuario_id AND u.status = 'ativo'
            LEFT JOIN profissionais p ON p.clinica_id = cu.clinica_id AND p.usuario_id = cu.usuario_id
              AND p.status = 'ativo'
            WHERE cu.clinica_id = ? AND cu.usuario_id = ? AND cu.papel = ?
              AND cu.status = 'ativo' LIMIT 1
        `, [clinicId, req.userId, role]);
        const actor = actors[0];
        if (!actor || (role === 'profissional' && !actor.profissional_id)) {
            return res.status(403).json({ error: 'Vínculo ativo não autorizado.' });
        }
        const ownProfessionalId = role === 'profissional' ? Number(actor.profissional_id) : null;
        if (ownProfessionalId && requestedProfessional && requestedProfessional !== ownProfessionalId) {
            return res.status(403).json({ error: 'O profissional só pode consultar a própria agenda.' });
        }
        const professionalId = ownProfessionalId || requestedProfessional;
        const start = zonedLocalToUtc(`${startDate}T00:00`, clinic.timezone);
        const last = zonedLocalToUtc(`${endDate}T23:59`, clinic.timezone);
        if (!start || !last) return res.status(400).json({ error: 'Período inválido para o fuso da clínica.' });
        const [rows] = await pool.execute(`
            SELECT c.id, c.inicio_em, c.fim_em, c.status, c.versao,
                (SELECT CASE WHEN cc.estado = 'preparada' AND cc.expira_em <= UTC_TIMESTAMP(6)
                    THEN 'expirada' ELSE cc.estado END
                 FROM confirmacoes_consulta cc
                 WHERE cc.clinica_id = c.clinica_id AND cc.consulta_id = c.id
                   AND cc.consulta_versao = c.versao
                 ORDER BY (cc.estado IN ('confirmada', 'recusada')) DESC, cc.id DESC LIMIT 1) AS confirmacao_estado,
                (SELECT cc.canal FROM confirmacoes_consulta cc
                 WHERE cc.clinica_id = c.clinica_id AND cc.consulta_id = c.id
                   AND cc.consulta_versao = c.versao
                 ORDER BY (cc.estado IN ('confirmada', 'recusada')) DESC, cc.id DESC LIMIT 1) AS confirmacao_canal,
                (SELECT cc.id FROM confirmacoes_consulta cc
                 WHERE cc.clinica_id = c.clinica_id AND cc.consulta_id = c.id
                   AND cc.consulta_versao = c.versao
                 ORDER BY cc.id DESC LIMIT 1) AS confirmacao_id,
                CASE
                  WHEN pa.confirmacao_vitalis_ativa = 1 AND pa.usuario_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM clinica_usuarios pacu
                      JOIN usuarios pau ON pau.id = pacu.usuario_id AND pau.status = 'ativo'
                      WHERE pacu.clinica_id = pa.clinica_id AND pacu.usuario_id = pa.usuario_id
                        AND pacu.papel = 'paciente' AND pacu.status = 'ativo')
                    THEN 'portal_vitalis'
                  WHEN pa.preferencia_contato = 'whatsapp' THEN 'whatsapp'
                  ELSE NULL
                END AS confirmacao_canal_recomendado,
                pa.id AS paciente_id, pa.nome AS paciente_nome,
                p.id AS profissional_id, p.nome_exibicao AS profissional_nome,
                e.id AS especialidade_id, e.nome AS especialidade_nome
            FROM consultas c
            JOIN clinicas clinic ON clinic.id = c.clinica_id AND clinic.status = 'ativa'
            JOIN clinica_usuarios viewer ON viewer.clinica_id = c.clinica_id
              AND viewer.usuario_id = ? AND viewer.papel = ? AND viewer.status = 'ativo'
            JOIN usuarios viewer_user ON viewer_user.id = viewer.usuario_id AND viewer_user.status = 'ativo'
            JOIN pacientes pa ON pa.clinica_id = c.clinica_id AND pa.id = c.paciente_id
            JOIN profissionais p ON p.clinica_id = c.clinica_id AND p.id = c.profissional_id
            LEFT JOIN especialidades e ON e.clinica_id = c.clinica_id AND e.id = c.especialidade_id
            WHERE c.clinica_id = ? AND c.inicio_em < ? AND c.fim_em > ?
              AND (? = 'todos' OR c.status = ?)
              AND (? IS NULL OR c.profissional_id = ?)
              AND (? IS NULL OR c.especialidade_id = ?)
              AND (? <> 'profissional' OR p.usuario_id = ?)
            ORDER BY c.inicio_em, c.id LIMIT 1001
        `, [
            req.userId, role, clinicId, mysqlUtc(new Date(last.getTime() + 60000)), mysqlUtc(start),
            status, status, professionalId, professionalId, specialtyId, specialtyId,
            role, req.userId
        ]);
        if (rows.length > 1000) {
            return res.status(422).json({
                error: 'Há muitas consultas no período. Selecione um profissional, especialidade ou período menor.'
            });
        }
        return res.status(200).json({
            timezone: clinic.timezone,
            consultas: rows.map((item) => ({
                ...item,
                id: Number(item.id), paciente_id: Number(item.paciente_id),
                profissional_id: Number(item.profissional_id),
                especialidade_id: item.especialidade_id ? Number(item.especialidade_id) : null,
                versao: Number(item.versao),
                inicio_local: utcToLocal(item.inicio_em, clinic.timezone),
                fim_local: utcToLocal(item.fim_em, clinic.timezone)
            }))
        });
    } catch (error) {
        logFailure('calendar_list', error);
        return res.status(500).json({ error: 'Erro ao carregar calendário.' });
    }
};

exports.availableSlots = async (req, res) => {
    const professionalId = positiveId(req.query?.profissional_id);
    const specialtyId = positiveId(req.query?.especialidade_id);
    const duration = boundedInteger(req.query?.duracao_minutos, 30, 240);
    const date = req.query?.data;
    if (!professionalId || !specialtyId || !duration || duration < 15 || duration % 5
        || typeof date !== 'string' || !DATE.test(date)) {
        return res.status(400).json({ error: 'Profissional, especialidade, data e duração são obrigatórios.' });
    }
    try {
        const clinic = await activeClinic(pool, req.tenant.clinicId);
        const professional = clinic && await activeProfessional(
            pool, req.tenant.clinicId, professionalId, specialtyId
        );
        if (!clinic || !professional) {
            return res.status(404).json({ error: 'Profissional ou especialidade não encontrado na clínica ativa.' });
        }
        const dayStart = zonedLocalToUtc(`${date}T00:00`, clinic.timezone);
        const dayEnd = zonedLocalToUtc(`${date}T23:59`, clinic.timezone);
        if (!dayStart || !dayEnd) return res.status(400).json({ error: 'Data inválida para o fuso da clínica.' });
        const day = new Date(`${date}T00:00:00Z`).getUTCDay();
        const intervals = await weeklyIntervals(pool, req.tenant.clinicId, professionalId, day);
        const upper = mysqlUtc(new Date(dayEnd.getTime() + 60000));
        const [[blocks], [appointments]] = await Promise.all([
            pool.execute(`SELECT inicio_em, fim_em FROM bloqueios_profissional
                WHERE clinica_id = ? AND profissional_id = ? AND status = 'ativo'
                AND inicio_em < ? AND fim_em > ?`,
            [req.tenant.clinicId, professionalId, upper, mysqlUtc(dayStart)]),
            pool.execute(`SELECT inicio_em, fim_em FROM consultas
                WHERE clinica_id = ? AND profissional_id = ? AND status IN ('agendada', 'confirmada')
                AND inicio_em < ? AND fim_em > ?`,
            [req.tenant.clinicId, professionalId, upper, mysqlUtc(dayStart)])
        ]);
        const dateValue = (value) => value instanceof Date
            ? value : new Date(`${String(value).replace(' ', 'T')}Z`);
        const busy = [...blocks, ...appointments].map((item) => ({
            start: dateValue(item.inicio_em), end: dateValue(item.fim_em)
        }));
        const slots = [];
        for (const interval of intervals.filter((item) => item.tipo === 'atendimento')) {
            const first = Number(interval.inicio.slice(0, 2)) * 60 + Number(interval.inicio.slice(3, 5));
            const last = Number(interval.fim.slice(0, 2)) * 60 + Number(interval.fim.slice(3, 5));
            for (let minute = first; minute + duration <= last; minute += 15) {
                const two = (value) => String(value).padStart(2, '0');
                const localStart = `${date}T${two(Math.floor(minute / 60))}:${two(minute % 60)}`;
                const start = zonedLocalToUtc(localStart, clinic.timezone);
                const period = start && { start, end: new Date(start.getTime() + duration * 60000) };
                const local = period && localPeriod(period, clinic.timezone);
                if (!period || !local || start <= new Date() || !periodFitsWeekly(intervals, local)) continue;
                if (busy.some((item) => period.start < item.end && period.end > item.start)) continue;
                slots.push({ inicio_local: localStart, inicio_em: start.toISOString() });
            }
        }
        return res.status(200).json({ timezone: clinic.timezone, horarios: slots });
    } catch (error) {
        logFailure('slots', error);
        return res.status(500).json({ error: 'Erro ao consultar horários disponíveis.' });
    }
};

exports.agendarConsulta = async (req, res) => {
    const professionalId = positiveId(req.body?.profissional_id);
    const patientId = positiveId(req.body?.paciente_id);
    const specialtyId = positiveId(req.body?.especialidade_id);
    if (!professionalId || !specialtyId || (req.tenant.role !== 'paciente' && !patientId)) {
        return res.status(400).json({ error: 'Paciente, profissional e especialidade válidos são obrigatórios.' });
    }
    let connection;
    try {
        connection = await pool.getConnection(); await connection.beginTransaction();
        if (!await activeOperator(connection, req)) return await rollback(connection, res, 403, 'Vínculo ativo não autorizado.');
        const practiceOwner = req.workspaceOwner ? await activePracticeOwner(connection, req) : null;
        if (req.workspaceOwner && (!practiceOwner
            || Number(practiceOwner.profissional_id) !== professionalId)) {
            return await rollback(
                connection, res, 403,
                'Titular do consultório não autorizado para este profissional.'
            );
        }
        const clinic = await activeClinic(connection, req.tenant.clinicId, true);
        const period = clinic && appointmentPeriod(req.body, clinic.timezone);
        if (!period) return await rollback(connection, res, 400, 'Data, horário ou duração inválida.');
        const professional = await activeProfessional(connection, req.tenant.clinicId, professionalId, specialtyId, true);
        const patient = await activePatient(connection, req, patientId, true);
        if (!professional || !patient) {
            return await rollback(connection, res, 404, 'Paciente, profissional ou especialidade não encontrado na clínica ativa.');
        }
        const valid = await validateReservation(connection, req.tenant.clinicId, professionalId, period, clinic.timezone);
        if (!valid.ok) return await rollback(connection, res, 409, 'Horário indisponível para este profissional.');
        const start = mysqlUtc(period.start); const end = mysqlUtc(period.end);
        const [insert] = await connection.execute(`INSERT INTO consultas (
            clinica_id, paciente_id, profissional_id, especialidade_id, inicio_em, fim_em,
            status, versao, criado_por_usuario_id
        ) VALUES (?, ?, ?, ?, ?, ?, 'agendada', 1, ?)`, [
            req.tenant.clinicId, patient.id, professionalId, professional.especialidade_id,
            start, end, req.userId
        ]);
        const appointment = { id: Number(insert.insertId), versao: 1, status: 'agendada', inicio_em: start, fim_em: end };
        await history(connection, req, appointment, 'agendada', null, {
            profissional_id: professionalId, especialidade_id: Number(professional.especialidade_id)
        });
        await audit(connection, req, 'consulta_agendada', appointment.id, {
            profissional_id: professionalId, especialidade_id: Number(professional.especialidade_id)
        });
        await connection.commit();
        return res.status(201).json({ id: appointment.id, message: 'Consulta agendada com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Horário indisponível para este profissional.' });
        logFailure('create', error);
        return res.status(500).json({ error: 'Erro ao agendar consulta.' });
    } finally { connection?.release(); }
};

exports.listForManagement = async (req, res) => {
    const status = req.query?.status || 'todos';
    const professionalId = req.query?.profissional_id ? positiveId(req.query.profissional_id) : null;
    const specialtyId = req.query?.especialidade_id ? positiveId(req.query.especialidade_id) : null;
    const page = boundedInteger(req.query?.pagina, 1, 100000);
    const limit = boundedInteger(req.query?.limite, 20, 50);
    if ((status !== 'todos' && !STATUSES.has(status)) || !page || !limit
        || (req.query?.profissional_id && !professionalId) || (req.query?.especialidade_id && !specialtyId)) {
        return res.status(400).json({ error: 'Filtros de agenda inválidos.' });
    }
    try {
        const clinic = await activeClinic(pool, req.tenant.clinicId);
        if (!clinic) return res.status(409).json({ error: 'Clínica ativa não disponível.' });
        const today = utcToLocal(new Date(), clinic.timezone).slice(0, 10);
        const startDate = req.query?.data_inicio || today;
        const endDate = req.query?.data_fim || startDate;
        if (!DATE.test(startDate) || !DATE.test(endDate) || endDate < startDate) {
            return res.status(400).json({ error: 'Período da agenda inválido.' });
        }
        const start = zonedLocalToUtc(`${startDate}T00:00`, clinic.timezone);
        const last = zonedLocalToUtc(`${endDate}T23:59`, clinic.timezone);
        if (!start || !last) return res.status(400).json({ error: 'Período inválido para o fuso da clínica.' });
        const params = [req.tenant.clinicId, mysqlUtc(start), mysqlUtc(new Date(last.getTime() + 60000)),
            status, status, professionalId, professionalId, specialtyId, specialtyId];
        const offset = (page - 1) * limit;
        const [[rows], [totals]] = await Promise.all([
            pool.execute(`SELECT c.id, c.inicio_em, c.fim_em, c.status, c.versao,
                c.fim_em <= UTC_TIMESTAMP(6) AS pode_marcar_falta,
                (SELECT CASE WHEN cc.estado = 'preparada' AND cc.expira_em <= UTC_TIMESTAMP(6)
                    THEN 'expirada' ELSE cc.estado END
                 FROM confirmacoes_consulta cc
                 WHERE cc.clinica_id = c.clinica_id AND cc.consulta_id = c.id
                   AND cc.consulta_versao = c.versao
                 ORDER BY (cc.estado IN ('confirmada', 'recusada')) DESC, cc.id DESC LIMIT 1) AS confirmacao_estado,
                (SELECT cc.canal FROM confirmacoes_consulta cc
                 WHERE cc.clinica_id = c.clinica_id AND cc.consulta_id = c.id
                   AND cc.consulta_versao = c.versao
                 ORDER BY (cc.estado IN ('confirmada', 'recusada')) DESC, cc.id DESC LIMIT 1) AS confirmacao_canal,
                (SELECT cc.id FROM confirmacoes_consulta cc
                 WHERE cc.clinica_id = c.clinica_id AND cc.consulta_id = c.id
                   AND cc.consulta_versao = c.versao
                 ORDER BY cc.id DESC LIMIT 1) AS confirmacao_id,
                CASE
                  WHEN pa.confirmacao_vitalis_ativa = 1 AND pa.usuario_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM clinica_usuarios pacu
                      JOIN usuarios pau ON pau.id = pacu.usuario_id AND pau.status = 'ativo'
                      WHERE pacu.clinica_id = pa.clinica_id AND pacu.usuario_id = pa.usuario_id
                        AND pacu.papel = 'paciente' AND pacu.status = 'ativo')
                    THEN 'portal_vitalis'
                  WHEN pa.preferencia_contato = 'whatsapp' THEN 'whatsapp'
                  ELSE NULL
                END AS confirmacao_canal_recomendado,
                pa.id AS paciente_id, pa.nome AS paciente_nome,
                p.id AS profissional_id, p.nome_exibicao AS profissional_nome,
                e.id AS especialidade_id, e.nome AS especialidade_nome
                FROM consultas c
                JOIN pacientes pa ON pa.clinica_id = c.clinica_id AND pa.id = c.paciente_id
                JOIN profissionais p ON p.clinica_id = c.clinica_id AND p.id = c.profissional_id
                LEFT JOIN especialidades e ON e.clinica_id = c.clinica_id AND e.id = c.especialidade_id
                WHERE c.clinica_id = ? AND c.inicio_em >= ? AND c.inicio_em < ?
                AND (? = 'todos' OR c.status = ?) AND (? IS NULL OR c.profissional_id = ?)
                AND (? IS NULL OR c.especialidade_id = ?)
                ORDER BY c.inicio_em, c.id LIMIT ${limit} OFFSET ${offset}`, params),
            pool.execute(`SELECT COUNT(*) AS total FROM consultas c
                WHERE c.clinica_id = ? AND c.inicio_em >= ? AND c.inicio_em < ?
                AND (? = 'todos' OR c.status = ?) AND (? IS NULL OR c.profissional_id = ?)
                AND (? IS NULL OR c.especialidade_id = ?)`, params)
        ]);
        return res.status(200).json({
            timezone: clinic.timezone,
            consultas: rows.map((item) => ({
                ...item, id: Number(item.id), paciente_id: Number(item.paciente_id),
                profissional_id: Number(item.profissional_id),
                especialidade_id: item.especialidade_id ? Number(item.especialidade_id) : null,
                versao: Number(item.versao), inicio_local: utcToLocal(item.inicio_em, clinic.timezone),
                fim_local: utcToLocal(item.fim_em, clinic.timezone),
                pode_marcar_falta: Boolean(item.pode_marcar_falta)
            })),
            paginacao: { pagina: page, limite: limit, total: Number(totals[0]?.total || 0) }
        });
    } catch (error) {
        logFailure('list', error);
        return res.status(500).json({ error: 'Erro ao carregar agenda.' });
    }
};

exports.getMinhaAgenda = async (req, res) => {
    const { clinicId, role } = req.tenant;
    try {
        const [rows] = await pool.execute(`SELECT c.id, c.inicio_em, c.fim_em, c.status, c.versao,
            c.inicio_em <= UTC_TIMESTAMP(6) AS pode_concluir,
            c.inicio_em > UTC_TIMESTAMP(6) AS futura,
            (c.inicio_em <= UTC_TIMESTAMP(6) AND c.fim_em > UTC_TIMESTAMP(6)) AS em_andamento,
            pa.id AS paciente_id, pa.nome AS nome_paciente,
            p.id AS profissional_id, p.nome_exibicao AS nome_profissional,
            e.id AS especialidade_id, e.nome AS nome_especialidade,
            (SELECT CASE WHEN cc.estado = 'preparada' AND cc.expira_em <= UTC_TIMESTAMP(6)
                THEN 'expirada' ELSE cc.estado END
             FROM confirmacoes_consulta cc
             WHERE cc.clinica_id = c.clinica_id AND cc.consulta_id = c.id
               AND cc.consulta_versao = c.versao
             ORDER BY (cc.estado IN ('confirmada', 'recusada')) DESC, cc.id DESC LIMIT 1) AS confirmacao_estado,
            (SELECT cc.canal FROM confirmacoes_consulta cc
             WHERE cc.clinica_id = c.clinica_id AND cc.consulta_id = c.id
               AND cc.consulta_versao = c.versao
             ORDER BY (cc.estado IN ('confirmada', 'recusada')) DESC, cc.id DESC LIMIT 1) AS confirmacao_canal,
            clinic.timezone
            FROM consultas c
            JOIN clinicas clinic ON clinic.id = c.clinica_id AND clinic.status = 'ativa'
            JOIN pacientes pa ON pa.clinica_id = c.clinica_id AND pa.id = c.paciente_id
            JOIN profissionais p ON p.clinica_id = c.clinica_id AND p.id = c.profissional_id
            LEFT JOIN especialidades e ON e.clinica_id = c.clinica_id AND e.id = c.especialidade_id
            JOIN clinica_usuarios actor ON actor.clinica_id = c.clinica_id
              AND actor.usuario_id = ? AND actor.papel = ? AND actor.status = 'ativo'
            JOIN usuarios actor_user ON actor_user.id = actor.usuario_id AND actor_user.status = 'ativo'
            WHERE c.clinica_id = ? AND (? IN ('administrador', 'secretaria')
              OR (? = 'profissional' AND p.usuario_id = ?)
              OR (? = 'paciente' AND pa.usuario_id = ?))
              AND (? <> 'profissional' OR p.status = 'ativo')
            ORDER BY c.inicio_em`,
        [req.userId, role, clinicId, role, role, req.userId, role, req.userId, role]);
        return res.status(200).json(rows.map((item) => ({
            ...item, id: Number(item.id), paciente_id: Number(item.paciente_id),
            profissional_id: Number(item.profissional_id), versao: Number(item.versao),
            pode_concluir: Boolean(item.pode_concluir), futura: Boolean(item.futura),
            em_andamento: Boolean(item.em_andamento),
            inicio_local: utcToLocal(item.inicio_em, item.timezone),
            fim_local: utcToLocal(item.fim_em, item.timezone)
        })));
    } catch (error) {
        logFailure('my_agenda', error);
        return res.status(500).json({ error: 'Erro ao buscar agenda.' });
    }
};

async function changeStatus(req, res, forced = null) {
    const appointmentId = positiveId(req.params.id);
    const target = forced || req.body?.status;
    const expectedVersion = positiveId(req.body?.versao);
    if (!appointmentId || !expectedVersion || !STATUSES.has(target) || target === 'agendada') {
        return res.status(400).json({ error: 'Consulta, versão ou status inválido.' });
    }
    let connection;
    try {
        connection = await pool.getConnection(); await connection.beginTransaction();
        const role = await activeOperator(connection, req);
        if (!role) return await rollback(connection, res, 403, 'Vínculo ativo não autorizado.');
        if (req.workspaceOwner && !await activePracticeOwner(connection, req)) {
            return await rollback(connection, res, 403, 'Titular do consultório não autorizado.');
        }
        const appointment = await lockedAppointment(connection, req, appointmentId);
        if (!appointment || !accessible(req, appointment)) return await rollback(connection, res, 404, 'Consulta não encontrada.');
        if (Number(appointment.versao) !== expectedVersion) {
            return await rollback(connection, res, 409, 'A consulta foi alterada. Atualize a agenda antes de continuar.');
        }
        if (role === 'paciente' && target !== 'cancelada') {
            return await rollback(connection, res, 403, 'Paciente somente pode cancelar a própria consulta.');
        }
        if (target === 'realizada' && (role !== 'profissional'
            || Number(appointment.profissional_usuario_id) !== req.userId
            || appointment.profissional_status !== 'ativo')) {
            return await rollback(connection, res, 403, 'Somente o profissional responsável pode concluir o atendimento.');
        }
        if (target === 'realizada'
            && !await activeClinic(connection, req.tenant.clinicId, true)) {
            return await rollback(connection, res, 409, 'Clínica ativa não disponível.');
        }
        if (target === 'nao_compareceu'
            && !['administrador', 'secretaria'].includes(role) && !req.workspaceOwner) {
            return await rollback(connection, res, 403, 'Somente a gestão da clínica pode registrar não comparecimento.');
        }
        if (!canTransition(appointment.status, target)) {
            return await rollback(connection, res, 409, 'Transição de status não permitida.');
        }
        if (!transitionAllowedAt(appointment, target)) {
            return await rollback(connection, res, 409, 'Esta alteração não é permitida no momento da consulta.');
        }
        const previous = { ...appointment }; const version = Number(appointment.versao) + 1;
        const [update] = await connection.execute(`UPDATE consultas SET status = ?, versao = ?
            WHERE clinica_id = ? AND id = ? AND versao = ?`,
        [target, version, req.tenant.clinicId, appointmentId, appointment.versao]);
        if (update.affectedRows !== 1) return await rollback(connection, res, 409, 'A consulta foi alterada por outra operação.');
        Object.assign(appointment, { status: target, versao: version });
        if (['cancelada', 'realizada', 'nao_compareceu'].includes(target)) {
            await revokePrepared(connection, req.tenant.clinicId, appointmentId, `consulta_${target}`, req.userId);
        }
        await history(connection, req, appointment, target === 'cancelada' ? 'cancelada' : 'status_alterado', previous);
        await audit(connection, req, `consulta_${target}`, appointmentId, {
            status_anterior: previous.status, status_novo: target, versao: version
        });
        await connection.commit();
        return res.status(200).json({ message: 'Situação da consulta atualizada com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('status', error);
        return res.status(500).json({ error: 'Erro ao atualizar consulta.' });
    } finally { connection?.release(); }
}

exports.updateStatusConsulta = (req, res) => changeStatus(req, res);
exports.concluirAtendimento = (req, res) => changeStatus(req, res, 'realizada');
exports.cancelarConsulta = (req, res) => changeStatus(req, res, 'cancelada');

exports.reschedule = async (req, res) => {
    const appointmentId = positiveId(req.params.id);
    const professionalId = positiveId(req.body?.profissional_id);
    const specialtyId = positiveId(req.body?.especialidade_id);
    const patientId = positiveId(req.body?.paciente_id);
    const expectedVersion = positiveId(req.body?.versao);
    if (!appointmentId || !professionalId || !specialtyId || !patientId || !expectedVersion) {
        return res.status(400).json({
            error: 'Consulta, versão, paciente, profissional e especialidade são obrigatórios.'
        });
    }
    let connection;
    try {
        connection = await pool.getConnection(); await connection.beginTransaction();
        const role = await activeOperator(connection, req);
        if (!['administrador', 'secretaria'].includes(role) && !req.workspaceOwner) {
            return await rollback(connection, res, 403, 'Papel não autorizado a reagendar consultas.');
        }
        const practiceOwner = req.workspaceOwner ? await activePracticeOwner(connection, req) : null;
        if (req.workspaceOwner && (!practiceOwner
            || Number(practiceOwner.profissional_id) !== professionalId)) {
            return await rollback(
                connection, res, 403,
                'Titular do consultório não autorizado para este profissional.'
            );
        }
        const clinic = await activeClinic(connection, req.tenant.clinicId, true);
        const period = clinic && appointmentPeriod(req.body, clinic.timezone);
        const professional = await activeProfessional(connection, req.tenant.clinicId, professionalId, specialtyId, true);
        const appointment = await lockedAppointment(connection, req, appointmentId);
        if (!appointment) return await rollback(connection, res, 404, 'Consulta não encontrada.');
        if (Number(appointment.versao) !== expectedVersion) {
            return await rollback(connection, res, 409, 'A consulta foi alterada. Atualize a agenda antes de continuar.');
        }
        if (Number(appointment.paciente_id) !== patientId) {
            return await rollback(connection, res, 409, 'O paciente da consulta não pode ser alterado no reagendamento.');
        }
        const patient = await activePatient(connection, req, appointment.paciente_id, true);
        if (!patient) return await rollback(connection, res, 409, 'O paciente da consulta não está ativo.');
        if (!ACTIVE.has(appointment.status)) return await rollback(connection, res, 409, 'Somente consultas ativas podem ser reagendadas.');
        if (!period) return await rollback(connection, res, 400, 'Data, horário ou duração inválida.');
        if (!professional) return await rollback(connection, res, 404, 'Profissional ou especialidade não encontrado na clínica ativa.');
        const valid = await validateReservation(
            connection, req.tenant.clinicId, professionalId, period, clinic.timezone, appointmentId
        );
        if (!valid.ok) return await rollback(connection, res, 409, 'Horário indisponível para este profissional.');
        const previous = { ...appointment }; const version = Number(appointment.versao) + 1;
        const start = mysqlUtc(period.start); const end = mysqlUtc(period.end);
        const [update] = await connection.execute(`UPDATE consultas SET profissional_id = ?,
            especialidade_id = ?, inicio_em = ?, fim_em = ?, status = 'agendada', versao = ?
            WHERE clinica_id = ? AND id = ? AND versao = ?`, [
            professionalId, specialtyId, start, end, version,
            req.tenant.clinicId, appointmentId, appointment.versao
        ]);
        if (update.affectedRows !== 1) return await rollback(connection, res, 409, 'A consulta foi alterada por outra operação.');
        Object.assign(appointment, {
            profissional_id: professionalId, especialidade_id: specialtyId,
            inicio_em: start, fim_em: end, status: 'agendada', versao: version
        });
        await revokePrepared(connection, req.tenant.clinicId, appointmentId, 'consulta_reagendada', req.userId);
        await history(connection, req, appointment, 'reagendada', previous, {
            profissional_anterior_id: Number(previous.profissional_id), profissional_novo_id: professionalId
        });
        await audit(connection, req, 'consulta_reagendada', appointmentId, {
            profissional_id: professionalId, especialidade_id: specialtyId, versao: version
        });
        await connection.commit();
        return res.status(200).json({ message: 'Consulta reagendada com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Horário indisponível para este profissional.' });
        if (error.code === 'ER_ROW_IS_REFERENCED_2') return res.status(409).json({ error: 'O profissional de uma consulta com registro clínico não pode ser substituído.' });
        logFailure('reschedule', error);
        return res.status(500).json({ error: 'Erro ao reagendar consulta.' });
    } finally { connection?.release(); }
};

exports.getHistory = async (req, res) => {
    const appointmentId = positiveId(req.params.id);
    if (!appointmentId) return res.status(400).json({ error: 'Consulta inválida.' });
    try {
        const [rows] = await pool.execute(`SELECT h.versao, h.acao, h.status_anterior,
            h.status_novo, h.inicio_anterior, h.fim_anterior, h.inicio_novo, h.fim_novo, h.criado_em
            FROM consultas_historico h
            JOIN consultas c ON c.clinica_id = h.clinica_id AND c.id = h.consulta_id
            JOIN profissionais p ON p.clinica_id = c.clinica_id AND p.id = c.profissional_id
            WHERE h.clinica_id = ? AND h.consulta_id = ?
            AND (? IN ('administrador', 'secretaria') OR (
                ? = 'profissional' AND p.usuario_id = ? AND p.status = 'ativo'
            ))
            ORDER BY h.versao, h.id`,
        [req.tenant.clinicId, appointmentId, req.tenant.role, req.tenant.role, req.userId]);
        if (!rows.length) return res.status(404).json({ error: 'Histórico da consulta não encontrado.' });
        return res.status(200).json(rows);
    } catch (error) {
        logFailure('history', error);
        return res.status(500).json({ error: 'Erro ao carregar histórico da consulta.' });
    }
};

exports.appointmentPeriod = appointmentPeriod;
exports.canTransition = canTransition;
exports.transitionAllowedAt = transitionAllowedAt;
exports.localPeriod = localPeriod;
exports.periodFitsWeekly = periodFitsWeekly;
exports.validateReservation = validateReservation;
exports.calendarRangeDays = calendarRangeDays;
