const pool = require('../config/database');
const { mysqlUtc, utcToLocal, zonedLocalToUtc } = require('../support/clinic-time');

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const BLOCK_TYPES = new Set(['ferias', 'feriado', 'indisponibilidade']);
const SLOT_TYPES = new Set(['atendimento', 'descanso']);

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function minuteOfDay(value) {
    if (typeof value !== 'string' || !TIME.test(value)) return null;
    const [hour, minute] = value.split(':').map(Number);
    return hour * 60 + minute;
}

function weeklyPayload(body = {}) {
    if (!Array.isArray(body.intervalos) || body.intervalos.length > 70) return null;
    const intervals = body.intervalos.map((item) => {
        const day = Number(item?.dia_semana);
        const startMinute = minuteOfDay(item?.inicio);
        const endMinute = minuteOfDay(item?.fim);
        if (!Number.isInteger(day) || day < 0 || day > 6 || !SLOT_TYPES.has(item?.tipo)
            || startMinute === null || endMinute === null || endMinute <= startMinute) return null;
        return {
            day,
            type: item.tipo,
            start: item.inicio,
            end: item.fim,
            startMinute,
            endMinute
        };
    });
    if (intervals.some((item) => item === null)) return null;
    intervals.sort((a, b) => a.day - b.day || a.startMinute - b.startMinute || a.endMinute - b.endMinute);
    for (let index = 1; index < intervals.length; index += 1) {
        const previous = intervals[index - 1];
        const current = intervals[index];
        if (previous.day === current.day && current.startMinute < previous.endMinute) return null;
    }
    return intervals;
}

function blockPayload(body = {}, timeZone) {
    if (!BLOCK_TYPES.has(body.tipo)) return null;
    const start = zonedLocalToUtc(body.inicio_local, timeZone);
    const end = zonedLocalToUtc(body.fim_local, timeZone);
    if (!start || !end || end <= start || end.getTime() - start.getTime() > 366 * 86400000) return null;
    const reason = typeof body.motivo === 'string' ? body.motivo.trim().replace(/\s+/g, ' ') : '';
    if (reason.length > 240) return null;
    return { type: body.tipo, start, end, reason: reason || null };
}

async function audit(connection, req, action, entityType, entityId, metadata = {}) {
    await connection.execute(`
        INSERT INTO auditoria (
            clinica_id, usuario_id, acao, entidade_tipo, entidade_id, metadados
        ) VALUES (?, ?, ?, ?, ?, ?)
    `, [
        req.tenant.clinicId, req.userId, action, entityType, entityId,
        JSON.stringify(metadata)
    ]);
}

async function clinicTimeZone(executor, clinicId) {
    const [rows] = await executor.execute(
        'SELECT timezone FROM clinicas WHERE id = ? AND status = \'ativa\' LIMIT 1',
        [clinicId]
    );
    return rows[0]?.timezone ?? null;
}

async function accessibleProfessional(executor, req, professionalId, lock = false) {
    const [rows] = await executor.execute(`
        SELECT p.id, p.nome_exibicao
        FROM profissionais p
        JOIN clinica_usuarios cu
          ON cu.clinica_id = p.clinica_id
         AND cu.usuario_id = p.usuario_id
         AND cu.papel = 'profissional'
         AND cu.status = 'ativo'
        JOIN usuarios u ON u.id = p.usuario_id AND u.status = 'ativo'
        WHERE p.clinica_id = ? AND p.id = ? AND p.status = 'ativo'
          AND (? <> 'profissional' OR p.usuario_id = ?)
        ${lock ? 'FOR UPDATE' : ''}
    `, [req.tenant.clinicId, professionalId, req.tenant.role, req.userId]);
    return rows[0] ?? null;
}

exports.context = async (req, res) => {
    const { clinicId, role } = req.tenant;
    try {
        const [[clinic], [professionals]] = await Promise.all([
            pool.execute('SELECT timezone FROM clinicas WHERE id = ? AND status = \'ativa\' LIMIT 1', [clinicId]),
            pool.execute(`
                SELECT p.id, p.nome_exibicao
                FROM profissionais p
                JOIN clinica_usuarios cu
                  ON cu.clinica_id = p.clinica_id
                 AND cu.usuario_id = p.usuario_id
                 AND cu.papel = 'profissional'
                 AND cu.status = 'ativo'
                JOIN usuarios u ON u.id = p.usuario_id AND u.status = 'ativo'
                WHERE p.clinica_id = ? AND p.status = 'ativo'
                  AND (? <> 'profissional' OR p.usuario_id = ?)
                ORDER BY p.nome_exibicao, p.id
            `, [clinicId, role, req.userId])
        ]);
        if (!clinic[0]) return res.status(409).json({ error: 'Clínica ativa não disponível.' });
        return res.status(200).json({
            timezone: clinic[0].timezone,
            profissionais: professionals.map((item) => ({
                id: Number(item.id), nome_exibicao: item.nome_exibicao
            }))
        });
    } catch (error) {
        console.error('Erro ao preparar disponibilidade:', error);
        return res.status(500).json({ error: 'Erro ao carregar profissionais e fuso da clínica.' });
    }
};

exports.getProfessionalAvailability = async (req, res) => {
    const professionalId = positiveId(req.params.professionalId);
    if (!professionalId) return res.status(400).json({ error: 'Profissional inválido.' });
    const { clinicId } = req.tenant;
    try {
        const professional = await accessibleProfessional(pool, req, professionalId);
        if (!professional) {
            return res.status(404).json({ error: 'Profissional não encontrado na clínica ativa.' });
        }
        const [[intervals], [blocks], timeZone] = await Promise.all([
            pool.execute(`
                SELECT id, dia_semana, tipo,
                       TIME_FORMAT(inicio_local, '%H:%i') AS inicio,
                       TIME_FORMAT(fim_local, '%H:%i') AS fim
                FROM disponibilidades_profissional
                WHERE clinica_id = ? AND profissional_id = ? AND status = 'ativo'
                ORDER BY dia_semana, inicio_local, fim_local
            `, [clinicId, professionalId]),
            pool.execute(`
                SELECT id, tipo, inicio_em, fim_em, motivo, status
                FROM bloqueios_profissional
                WHERE clinica_id = ? AND profissional_id = ?
                ORDER BY inicio_em DESC, id DESC
            `, [clinicId, professionalId]),
            clinicTimeZone(pool, clinicId)
        ]);
        if (!timeZone) return res.status(409).json({ error: 'Fuso horário da clínica não disponível.' });
        return res.status(200).json({
            timezone: timeZone,
            intervalos: intervals.map((item) => ({ ...item, id: Number(item.id) })),
            bloqueios: blocks.map((item) => ({
                ...item,
                id: Number(item.id),
                inicio_local: utcToLocal(item.inicio_em, timeZone),
                fim_local: utcToLocal(item.fim_em, timeZone)
            }))
        });
    } catch (error) {
        console.error('Erro ao consultar disponibilidade:', error);
        return res.status(500).json({ error: 'Erro ao consultar disponibilidade.' });
    }
};

exports.replaceWeeklyAvailability = async (req, res) => {
    const professionalId = positiveId(req.params.professionalId);
    const intervals = weeklyPayload(req.body);
    if (!professionalId || !intervals) {
        return res.status(400).json({ error: 'Grade semanal inválida ou com horários sobrepostos.' });
    }
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const professional = await accessibleProfessional(connection, req, professionalId, true);
        if (!professional) {
            await connection.rollback();
            return res.status(404).json({ error: 'Profissional não encontrado na clínica ativa.' });
        }
        await connection.execute(`
            UPDATE disponibilidades_profissional SET status = 'inativo'
            WHERE clinica_id = ? AND profissional_id = ? AND status = 'ativo'
        `, [req.tenant.clinicId, professionalId]);
        for (const interval of intervals) {
            await connection.execute(`
                INSERT INTO disponibilidades_profissional (
                    clinica_id, profissional_id, dia_semana, tipo,
                    inicio_local, fim_local, status
                ) VALUES (?, ?, ?, ?, ?, ?, 'ativo')
                ON DUPLICATE KEY UPDATE status = 'ativo', atualizado_em = CURRENT_TIMESTAMP(6)
            `, [
                req.tenant.clinicId, professionalId, interval.day, interval.type,
                interval.start, interval.end
            ]);
        }
        await audit(connection, req, 'disponibilidade_semanal_atualizada', 'profissional', professionalId, {
            total_intervalos: intervals.length
        });
        await connection.commit();
        return res.status(200).json({ message: 'Disponibilidade semanal atualizada com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        console.error('Erro ao atualizar disponibilidade semanal:', error);
        return res.status(500).json({ error: 'Erro ao atualizar disponibilidade semanal.' });
    } finally {
        connection?.release();
    }
};

exports.createBlock = async (req, res) => {
    const professionalId = positiveId(req.params.professionalId);
    if (!professionalId) return res.status(400).json({ error: 'Profissional inválido.' });
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const professional = await accessibleProfessional(connection, req, professionalId, true);
        if (!professional) {
            await connection.rollback();
            return res.status(404).json({ error: 'Profissional não encontrado na clínica ativa.' });
        }
        const timeZone = await clinicTimeZone(connection, req.tenant.clinicId);
        const block = blockPayload(req.body, timeZone);
        if (!block) {
            await connection.rollback();
            return res.status(400).json({ error: 'Período, tipo ou horário local inválido para o fuso da clínica.' });
        }
        const [overlaps] = await connection.execute(`
            SELECT id FROM bloqueios_profissional
            WHERE clinica_id = ? AND profissional_id = ? AND status = 'ativo'
              AND inicio_em < ? AND fim_em > ?
            LIMIT 1
        `, [req.tenant.clinicId, professionalId, mysqlUtc(block.end), mysqlUtc(block.start)]);
        if (overlaps.length) {
            await connection.rollback();
            return res.status(409).json({ error: 'Já existe um bloqueio sobreposto para este profissional.' });
        }
        const [result] = await connection.execute(`
            INSERT INTO bloqueios_profissional (
                clinica_id, profissional_id, tipo, inicio_em, fim_em,
                motivo, status, criado_por_usuario_id
            ) VALUES (?, ?, ?, ?, ?, ?, 'ativo', ?)
        `, [
            req.tenant.clinicId, professionalId, block.type,
            mysqlUtc(block.start), mysqlUtc(block.end), block.reason, req.userId
        ]);
        const blockId = Number(result.insertId);
        await audit(connection, req, 'bloqueio_profissional_criado', 'bloqueio_profissional', blockId, {
            profissional_id: professionalId, tipo: block.type
        });
        await connection.commit();
        return res.status(201).json({ id: blockId, message: 'Bloqueio cadastrado com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        console.error('Erro ao cadastrar bloqueio:', error);
        return res.status(500).json({ error: 'Erro ao cadastrar bloqueio.' });
    } finally {
        connection?.release();
    }
};

exports.cancelBlock = async (req, res) => {
    const professionalId = positiveId(req.params.professionalId);
    const blockId = positiveId(req.params.blockId);
    if (!professionalId || !blockId) return res.status(400).json({ error: 'Profissional ou bloqueio inválido.' });
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const professional = await accessibleProfessional(connection, req, professionalId, true);
        if (!professional) {
            await connection.rollback();
            return res.status(404).json({ error: 'Profissional não encontrado na clínica ativa.' });
        }
        const [result] = await connection.execute(`
            UPDATE bloqueios_profissional
            SET status = 'cancelado', cancelado_por_usuario_id = ?, cancelado_em = UTC_TIMESTAMP(6)
            WHERE clinica_id = ? AND profissional_id = ? AND id = ? AND status = 'ativo'
        `, [req.userId, req.tenant.clinicId, professionalId, blockId]);
        if (!result.affectedRows) {
            await connection.rollback();
            return res.status(404).json({ error: 'Bloqueio ativo não encontrado na clínica ativa.' });
        }
        await audit(connection, req, 'bloqueio_profissional_cancelado', 'bloqueio_profissional', blockId, {
            profissional_id: professionalId
        });
        await connection.commit();
        return res.status(200).json({ message: 'Bloqueio cancelado com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        console.error('Erro ao cancelar bloqueio:', error);
        return res.status(500).json({ error: 'Erro ao cancelar bloqueio.' });
    } finally {
        connection?.release();
    }
};

exports.blockPayload = blockPayload;
exports.weeklyPayload = weeklyPayload;
