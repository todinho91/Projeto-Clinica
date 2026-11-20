const pool = require('../config/database');
const { confirmation } = require('../config/environment');
const { mysqlUtc, utcToLocal } = require('../support/clinic-time');
const { createConfirmationToken, hashConfirmationToken } = require('../support/confirmation-token');

const RESPONSES = new Set(['confirmada', 'recusada']);

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function whatsappNumber(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 10 || digits.length === 11) return `55${digits}`;
    return digits.length >= 12 && digits.length <= 15 ? digits : null;
}

function utcDate(value) {
    if (value instanceof Date) return value;
    const text = String(value).replace(' ', 'T');
    return new Date(/(?:Z|[+-]\d{2}:\d{2})$/i.test(text) ? text : `${text}Z`);
}

function logFailure(operation, error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code : 'UNEXPECTED';
    console.error('[confirmacoes_consulta] operation_failed', { operation, code });
}

function publicUrl(token) {
    const url = new URL('/confirmacao-consulta.html', confirmation.publicOrigin);
    url.searchParams.set('token', token);
    return url.toString();
}

function whatsappUrl(phone, clinicName, localStart, link) {
    const number = whatsappNumber(phone);
    if (!number) return null;
    const date = `${localStart.slice(8, 10)}/${localStart.slice(5, 7)}/${localStart.slice(0, 4)}`;
    const time = localStart.slice(11, 16);
    const message = `Olá! A ${clinicName} solicita a confirmação da sua consulta em ${date} às ${time}. `
        + `Confirme ou informe que não poderá comparecer pelo link seguro: ${link}`;
    return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

async function activeManager(connection, req) {
    const [rows] = await connection.execute(`
        SELECT cu.papel FROM clinica_usuarios cu
        JOIN usuarios u ON u.id = cu.usuario_id AND u.status = 'ativo'
        JOIN clinicas c ON c.id = cu.clinica_id AND c.status = 'ativa'
        WHERE cu.clinica_id = ? AND cu.usuario_id = ? AND cu.papel = ?
          AND cu.papel IN ('administrador', 'secretaria') AND cu.status = 'ativo'
        LIMIT 1 FOR UPDATE
    `, [req.tenant.clinicId, req.userId, req.tenant.role]);
    return rows[0]?.papel ?? null;
}

async function revokePrepared(connection, clinicId, appointmentId, reason, userId = null) {
    await connection.execute(`
        INSERT INTO confirmacoes_consulta_eventos
            (clinica_id, confirmacao_id, evento, origem, usuario_id, metadados)
        SELECT clinica_id, id, 'revogada', ?, ?, JSON_OBJECT('motivo', ?)
        FROM confirmacoes_consulta
        WHERE clinica_id = ? AND consulta_id = ? AND estado = 'preparada'
    `, [userId ? 'operador' : 'sistema', userId, reason, clinicId, appointmentId]);
    await connection.execute(`
        UPDATE confirmacoes_consulta
        SET estado = 'revogada', revogado_em = UTC_TIMESTAMP(6), motivo_revogacao = ?
        WHERE clinica_id = ? AND consulta_id = ? AND estado = 'preparada'
    `, [reason, clinicId, appointmentId]);
}

async function audit(connection, clinicId, userId, action, appointmentId, metadata = {}) {
    await connection.execute(`
        INSERT INTO auditoria (clinica_id, usuario_id, acao, entidade_tipo, entidade_id, metadados)
        VALUES (?, ?, ?, 'consulta_confirmacao', ?, ?)
    `, [clinicId, userId, action, appointmentId, JSON.stringify(metadata)]);
}

exports.requestConfirmation = async (req, res) => {
    const appointmentId = positiveId(req.params.id);
    const expectedVersion = positiveId(req.body?.versao);
    if (!appointmentId || !expectedVersion) {
        return res.status(400).json({ error: 'Consulta e versão válidas são obrigatórias.' });
    }
    let connection;
    try {
        connection = await pool.getConnection(); await connection.beginTransaction();
        if (!await activeManager(connection, req)) {
            await connection.rollback();
            return res.status(403).json({ error: 'Permissão insuficiente para solicitar confirmação.' });
        }
        const [rows] = await connection.execute(`
            SELECT c.id, c.versao, c.status, c.inicio_em, clinic.nome AS clinica_nome,
                   clinic.timezone, pa.telefone, pa.preferencia_contato, pa.status AS paciente_status
            FROM consultas c
            JOIN clinicas clinic ON clinic.id = c.clinica_id AND clinic.status = 'ativa'
            JOIN pacientes pa ON pa.clinica_id = c.clinica_id AND pa.id = c.paciente_id
            WHERE c.clinica_id = ? AND c.id = ? LIMIT 1 FOR UPDATE
        `, [req.tenant.clinicId, appointmentId]);
        const appointment = rows[0];
        if (!appointment) {
            await connection.rollback();
            return res.status(404).json({ error: 'Consulta não encontrada na clínica ativa.' });
        }
        if (Number(appointment.versao) !== expectedVersion) {
            await connection.rollback();
            return res.status(409).json({ error: 'A consulta foi alterada. Atualize a agenda.' });
        }
        if (!['agendada', 'confirmada'].includes(appointment.status)
            || appointment.paciente_status !== 'ativo' || utcDate(appointment.inicio_em) <= new Date()) {
            await connection.rollback();
            return res.status(409).json({ error: 'A consulta ou o paciente não permite nova confirmação.' });
        }
        if (appointment.preferencia_contato !== 'whatsapp' || !whatsappNumber(appointment.telefone)) {
            await connection.rollback();
            return res.status(422).json({
                error: 'O paciente precisa ter telefone válido e preferência explícita por WhatsApp.'
            });
        }
        await revokePrepared(connection, req.tenant.clinicId, appointmentId, 'nova_solicitacao', req.userId);
        const token = createConfirmationToken();
        const tokenHash = hashConfirmationToken(token);
        const expiration = new Date(Math.min(
            Date.now() + confirmation.ttlHours * 3600000,
            utcDate(appointment.inicio_em).getTime()
        ));
        const [insert] = await connection.execute(`
            INSERT INTO confirmacoes_consulta (
                clinica_id, consulta_id, consulta_versao, canal, estado, estado_entrega,
                token_hash, expira_em, solicitado_por_usuario_id
            ) VALUES (?, ?, ?, 'whatsapp', 'preparada', 'nao_enviado', ?, ?, ?)
        `, [req.tenant.clinicId, appointmentId, expectedVersion, tokenHash, mysqlUtc(expiration), req.userId]);
        const confirmationId = Number(insert.insertId);
        await connection.execute(`
            INSERT INTO confirmacoes_consulta_eventos
                (clinica_id, confirmacao_id, evento, origem, usuario_id)
            VALUES (?, ?, 'criada', 'operador', ?)
        `, [req.tenant.clinicId, confirmationId, req.userId]);
        await audit(connection, req.tenant.clinicId, req.userId, 'confirmacao_preparada', appointmentId, {
            confirmacao_id: confirmationId, canal: 'whatsapp', estado_entrega: 'nao_enviado'
        });
        await connection.commit();
        const link = publicUrl(token);
        return res.status(201).json({
            confirmacao_id: confirmationId,
            estado: 'preparada',
            estado_entrega: 'nao_enviado',
            expira_em: expiration.toISOString(),
            whatsapp_url: whatsappUrl(
                appointment.telefone, appointment.clinica_nome,
                utcToLocal(appointment.inicio_em, appointment.timezone), link
            ),
            message: 'Solicitação preparada. Abrir o WhatsApp não comprova envio nem entrega.'
        });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('request', error);
        return res.status(500).json({ error: 'Erro ao preparar confirmação.' });
    } finally { connection?.release(); }
};

exports.manualResponse = async (req, res) => {
    const appointmentId = positiveId(req.params.id);
    const expectedVersion = positiveId(req.body?.versao);
    const answer = req.body?.resposta;
    if (!appointmentId || !expectedVersion || !RESPONSES.has(answer)) {
        return res.status(400).json({ error: 'Consulta, versão e resposta válidas são obrigatórias.' });
    }
    let connection;
    try {
        connection = await pool.getConnection(); await connection.beginTransaction();
        if (!await activeManager(connection, req)) {
            await connection.rollback();
            return res.status(403).json({ error: 'Permissão insuficiente para registrar resposta.' });
        }
        const [rows] = await connection.execute(`SELECT id, versao, status, inicio_em FROM consultas
            WHERE clinica_id = ? AND id = ? LIMIT 1 FOR UPDATE`, [req.tenant.clinicId, appointmentId]);
        const appointment = rows[0];
        if (!appointment) { await connection.rollback(); return res.status(404).json({ error: 'Consulta não encontrada.' }); }
        if (Number(appointment.versao) !== expectedVersion) {
            await connection.rollback(); return res.status(409).json({ error: 'A consulta foi alterada. Atualize a agenda.' });
        }
        if (!['agendada', 'confirmada'].includes(appointment.status)
            || utcDate(appointment.inicio_em) <= new Date()) {
            await connection.rollback(); return res.status(409).json({ error: 'A consulta não aceita confirmação.' });
        }
        await revokePrepared(connection, req.tenant.clinicId, appointmentId, 'resposta_manual', req.userId);
        const [insert] = await connection.execute(`
            INSERT INTO confirmacoes_consulta (
                clinica_id, consulta_id, consulta_versao, canal, estado,
                solicitado_por_usuario_id, respondido_por_usuario_id, respondido_em
            ) VALUES (?, ?, ?, 'manual', ?, ?, ?, UTC_TIMESTAMP(6))
        `, [req.tenant.clinicId, appointmentId, expectedVersion, answer, req.userId, req.userId]);
        await connection.execute(`INSERT INTO confirmacoes_consulta_eventos
            (clinica_id, confirmacao_id, evento, origem, usuario_id)
            VALUES (?, ?, ?, 'operador', ?)`, [req.tenant.clinicId, insert.insertId, answer, req.userId]);
        await audit(connection, req.tenant.clinicId, req.userId, `confirmacao_${answer}_manual`, appointmentId);
        await connection.commit();
        return res.status(201).json({ message: 'Resposta do paciente registrada manualmente.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('manual', error);
        return res.status(500).json({ error: 'Erro ao registrar resposta manual.' });
    } finally { connection?.release(); }
};

exports.history = async (req, res) => {
    const appointmentId = positiveId(req.params.id);
    if (!appointmentId) return res.status(400).json({ error: 'Consulta inválida.' });
    try {
        const [rows] = await pool.execute(`
            SELECT cc.id, cc.consulta_versao, cc.canal,
                CASE WHEN cc.estado = 'preparada' AND cc.expira_em <= UTC_TIMESTAMP(6)
                    THEN 'expirada' ELSE cc.estado END AS estado,
                cc.estado_entrega, cc.expira_em, cc.respondido_em, cc.motivo_revogacao, cc.criado_em
            FROM confirmacoes_consulta cc
            JOIN consultas c ON c.clinica_id = cc.clinica_id AND c.id = cc.consulta_id
            WHERE cc.clinica_id = ? AND cc.consulta_id = ?
            ORDER BY cc.id DESC
        `, [req.tenant.clinicId, appointmentId]);
        return res.status(200).json({ confirmacoes: rows });
    } catch (error) {
        logFailure('history', error);
        return res.status(500).json({ error: 'Erro ao consultar histórico de confirmações.' });
    }
};

exports.inspectPublic = async (req, res) => {
    const tokenHash = hashConfirmationToken(req.params.token);
    if (!tokenHash) return res.status(404).json({ error: 'Link de confirmação inválido.' });
    try {
        const [rows] = await pool.execute(`
            SELECT cc.estado, cc.expira_em, cc.consulta_versao, c.versao, c.status,
                   c.inicio_em, clinic.nome AS clinica_nome, clinic.timezone,
                   p.nome_exibicao AS profissional_nome, e.nome AS especialidade_nome
            FROM confirmacoes_consulta cc
            JOIN consultas c ON c.clinica_id = cc.clinica_id AND c.id = cc.consulta_id
            JOIN clinicas clinic ON clinic.id = cc.clinica_id AND clinic.status = 'ativa'
            JOIN profissionais p ON p.clinica_id = c.clinica_id AND p.id = c.profissional_id
            LEFT JOIN especialidades e ON e.clinica_id = c.clinica_id AND e.id = c.especialidade_id
            WHERE cc.token_hash = ? LIMIT 1
        `, [tokenHash]);
        const item = rows[0];
        if (!item) return res.status(404).json({ error: 'Link de confirmação inválido.' });
        const expired = new Date(item.expira_em) <= new Date();
        const active = item.estado === 'preparada' && !expired && utcDate(item.inicio_em) > new Date()
            && Number(item.consulta_versao) === Number(item.versao)
            && ['agendada', 'confirmada'].includes(item.status);
        return res.status(active ? 200 : 410).json({
            clinica_nome: item.clinica_nome,
            profissional_nome: item.profissional_nome,
            especialidade_nome: item.especialidade_nome,
            inicio_local: utcToLocal(item.inicio_em, item.timezone),
            estado: expired && item.estado === 'preparada' ? 'expirada' : item.estado,
            pode_responder: active
        });
    } catch (error) {
        logFailure('inspect_public', error);
        return res.status(500).json({ error: 'Erro ao consultar confirmação.' });
    }
};

exports.respondPublic = async (req, res) => {
    const tokenHash = hashConfirmationToken(req.params.token);
    const answer = req.body?.resposta;
    if (!tokenHash || !RESPONSES.has(answer)) return res.status(400).json({ error: 'Resposta inválida.' });
    let connection;
    try {
        connection = await pool.getConnection(); await connection.beginTransaction();
        const [rows] = await connection.execute(`
            SELECT cc.id, cc.clinica_id, cc.consulta_id, cc.consulta_versao, cc.estado,
                   cc.expira_em, c.versao, c.status, c.inicio_em
            FROM confirmacoes_consulta cc
            JOIN consultas c ON c.clinica_id = cc.clinica_id AND c.id = cc.consulta_id
            JOIN clinicas clinic ON clinic.id = cc.clinica_id AND clinic.status = 'ativa'
            WHERE cc.token_hash = ? LIMIT 1 FOR UPDATE
        `, [tokenHash]);
        const item = rows[0];
        if (!item) { await connection.rollback(); return res.status(404).json({ error: 'Link de confirmação inválido.' }); }
        if (item.estado !== 'preparada' || new Date(item.expira_em) <= new Date()
            || Number(item.consulta_versao) !== Number(item.versao) || utcDate(item.inicio_em) <= new Date()
            || !['agendada', 'confirmada'].includes(item.status)) {
            await connection.rollback();
            return res.status(409).json({ error: 'Este link não está mais disponível.' });
        }
        const [updated] = await connection.execute(`UPDATE confirmacoes_consulta
            SET estado = ?, respondido_em = UTC_TIMESTAMP(6)
            WHERE id = ? AND estado = 'preparada'`, [answer, item.id]);
        if (updated.affectedRows !== 1) {
            await connection.rollback(); return res.status(409).json({ error: 'A resposta já foi registrada.' });
        }
        await connection.execute(`INSERT INTO confirmacoes_consulta_eventos
            (clinica_id, confirmacao_id, evento, origem)
            VALUES (?, ?, ?, 'link_publico')`, [item.clinica_id, item.id, answer]);
        await audit(connection, item.clinica_id, null, `confirmacao_${answer}_publica`, item.consulta_id, {
            confirmacao_id: Number(item.id)
        });
        await connection.commit();
        return res.status(200).json({
            estado: answer,
            message: answer === 'confirmada'
                ? 'Presença confirmada. Obrigado por responder.'
                : 'Informação registrada. A clínica poderá entrar em contato.'
        });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('respond_public', error);
        return res.status(500).json({ error: 'Erro ao registrar confirmação.' });
    } finally { connection?.release(); }
};

exports.revokePrepared = revokePrepared;
exports.whatsappNumber = whatsappNumber;
