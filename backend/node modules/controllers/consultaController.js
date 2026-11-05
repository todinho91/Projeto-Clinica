const pool = require('../config/database');

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parsePeriod(start, end) {
    if (typeof start !== 'string' || typeof end !== 'string') return null;
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) return null;
    if (endDate <= startDate) return null;
    const toMysqlUtc = (date) => date.toISOString().slice(0, 23).replace('T', ' ');
    return { start: toMysqlUtc(startDate), end: toMysqlUtc(endDate) };
}

exports.agendarConsulta = async (req, res) => {
    const professionalId = positiveId(req.body?.profissional_id);
    const requestedPatientId = positiveId(req.body?.paciente_id);
    const { inicio_em: start, fim_em: end } = req.body ?? {};
    const period = parsePeriod(start, end);

    if (!professionalId || !period) {
        return res.status(400).json({
            error: 'Profissional, início e fim válidos são obrigatórios.'
        });
    }
    if (req.tenant.role !== 'paciente' && !requestedPatientId) {
        return res.status(400).json({ error: 'Paciente é obrigatório.' });
    }

    const clinicId = req.tenant.clinicId;
    try {
        const [references] = await pool.execute(`
            SELECT
                (
                    SELECT id FROM pacientes
                    WHERE clinica_id = ?
                      AND status = 'ativo'
                      AND (? = 'paciente' AND usuario_id = ? OR ? <> 'paciente' AND id = ?)
                    LIMIT 1
                ) AS paciente_id,
                (
                    SELECT id FROM profissionais
                    WHERE clinica_id = ? AND id = ? AND status = 'ativo'
                    LIMIT 1
                ) AS profissional_id
        `, [
            clinicId,
            req.tenant.role,
            req.userId,
            req.tenant.role,
            requestedPatientId,
            clinicId,
            professionalId
        ]);

        const patientId = references[0]?.paciente_id;
        if (!patientId || !references[0]?.profissional_id) {
            return res.status(404).json({ error: 'Paciente ou profissional não encontrado na clínica ativa.' });
        }

        const [result] = await pool.execute(`
            INSERT INTO consultas (
                clinica_id, paciente_id, profissional_id, inicio_em, fim_em,
                status, criado_por_usuario_id
            ) VALUES (?, ?, ?, ?, ?, 'agendada', ?)
        `, [clinicId, patientId, professionalId, period.start, period.end, req.userId]);

        return res.status(201).json({
            id: Number(result.insertId),
            message: 'Consulta agendada com sucesso.'
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'O profissional já possui consulta neste horário.' });
        }
        console.error('Erro ao agendar consulta:', error);
        return res.status(500).json({ error: 'Erro ao agendar consulta.' });
    }
};

exports.getMinhaAgenda = async (req, res) => {
    const { clinicId, role } = req.tenant;
    try {
        const [agenda] = await pool.execute(`
            SELECT
                c.id, c.inicio_em, c.fim_em, c.status,
                pa.id AS paciente_id, pa.nome AS nome_paciente,
                pr.id AS profissional_id, pr.nome_exibicao AS nome_profissional
            FROM consultas c
            JOIN pacientes pa
              ON pa.clinica_id = c.clinica_id
             AND pa.id = c.paciente_id
            JOIN profissionais pr
              ON pr.clinica_id = c.clinica_id
             AND pr.id = c.profissional_id
            WHERE c.clinica_id = ?
              AND (
                    ? IN ('administrador', 'secretaria')
                 OR (? = 'profissional' AND pr.usuario_id = ?)
                 OR (? = 'paciente' AND pa.usuario_id = ?)
              )
            ORDER BY c.inicio_em ASC
        `, [clinicId, role, role, req.userId, role, req.userId]);
        return res.status(200).json(agenda);
    } catch (error) {
        console.error('Erro ao buscar agenda:', error);
        return res.status(500).json({ error: 'Erro ao buscar agenda.' });
    }
};

exports.updateStatusConsulta = async (req, res) => {
    const appointmentId = positiveId(req.params.id);
    const status = req.body?.status;
    const allowedStatuses = new Set([
        'agendada', 'confirmada', 'realizada', 'cancelada', 'nao_compareceu'
    ]);
    if (!appointmentId || !allowedStatuses.has(status)) {
        return res.status(400).json({ error: 'Consulta ou status inválido.' });
    }

    const { clinicId, role } = req.tenant;
    try {
        const [result] = await pool.execute(`
            UPDATE consultas c
            SET status = ?
            WHERE c.clinica_id = ?
              AND c.id = ?
              AND (
                    ? <> 'profissional'
                 OR EXISTS (
                        SELECT 1 FROM profissionais p
                        WHERE p.clinica_id = c.clinica_id
                          AND p.id = c.profissional_id
                          AND p.usuario_id = ?
                    )
              )
        `, [status, clinicId, appointmentId, role, req.userId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Consulta não encontrada.' });
        }
        return res.status(200).json({ message: `Status atualizado para ${status}.` });
    } catch (error) {
        console.error('Erro ao atualizar consulta:', error);
        return res.status(500).json({ error: 'Erro ao atualizar consulta.' });
    }
};

exports.cancelarConsulta = async (req, res) => {
    const appointmentId = positiveId(req.params.id);
    if (!appointmentId) {
        return res.status(400).json({ error: 'Consulta inválida.' });
    }

    const { clinicId, role } = req.tenant;
    try {
        const [result] = await pool.execute(`
            UPDATE consultas c
            SET status = 'cancelada'
            WHERE c.clinica_id = ?
              AND c.id = ?
              AND (
                    ? <> 'paciente'
                 OR EXISTS (
                        SELECT 1 FROM pacientes p
                        WHERE p.clinica_id = c.clinica_id
                          AND p.id = c.paciente_id
                          AND p.usuario_id = ?
                    )
              )
        `, [clinicId, appointmentId, role, req.userId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Consulta não encontrada.' });
        }
        return res.status(200).json({ message: 'Consulta cancelada com sucesso.' });
    } catch (error) {
        console.error('Erro ao cancelar consulta:', error);
        return res.status(500).json({ error: 'Erro ao cancelar consulta.' });
    }
};
