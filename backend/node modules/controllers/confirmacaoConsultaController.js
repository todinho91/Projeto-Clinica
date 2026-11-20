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
    const raw = String(value || '').trim();
    const digits = raw.replace(/\D/g, '');
    if (raw.startsWith('+')) return /^[1-9]\d{7,14}$/.test(digits) ? digits : null;
    const brazilian = digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
    return /^55[1-9]\d[2-9]\d{7,8}$/.test(brazilian) ? brazilian : null;
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
    return `${url.toString()}#token=${encodeURIComponent(token)}`;
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

async function currentConfirmation(connection, clinicId, appointmentId, version) {
    const [rows] = await connection.execute(`
        SELECT id, canal,
            CASE WHEN estado = 'preparada' AND expira_em <= UTC_TIMESTAMP(6)
                THEN 'expirada' ELSE estado END AS estado,
            expira_em
        FROM confirmacoes_consulta
        WHERE clinica_id = ? AND consulta_id = ? AND consulta_versao = ?
        ORDER BY id DESC LIMIT 1 FOR UPDATE
    `, [clinicId, appointmentId, version]);
    return rows[0] ?? null;
}

async function latestTerminalConfirmation(connection, clinicId, appointmentId, version, excludeId = 0) {
    const [rows] = await connection.execute(`
        SELECT id, canal, estado
        FROM confirmacoes_consulta
        WHERE clinica_id = ? AND consulta_id = ? AND consulta_versao = ?
          AND estado IN ('confirmada', 'recusada') AND id <> ?
        ORDER BY id DESC LIMIT 1 FOR UPDATE
    `, [clinicId, appointmentId, version, excludeId]);
    return rows[0] ?? null;
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
            JOIN profissionais p ON p.clinica_id = c.clinica_id AND p.id = c.profissional_id
              AND p.status = 'ativo'
            LEFT JOIN clinica_usuarios pcu ON pcu.clinica_id = p.clinica_id
              AND pcu.usuario_id = p.usuario_id AND pcu.papel = 'profissional'
            LEFT JOIN usuarios pu ON pu.id = p.usuario_id
            LEFT JOIN clinica_usuarios pacu ON pacu.clinica_id = pa.clinica_id
              AND pacu.usuario_id = pa.usuario_id AND pacu.papel = 'paciente'
            LEFT JOIN usuarios pau ON pau.id = pa.usuario_id
            WHERE c.clinica_id = ? AND c.id = ?
              AND (p.usuario_id IS NULL OR (pcu.status = 'ativo' AND pu.status = 'ativo'))
              AND (pa.usuario_id IS NULL OR (pacu.status = 'ativo' AND pau.status = 'ativo'))
            LIMIT 1 FOR UPDATE
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
        const existing = await currentConfirmation(
            connection, req.tenant.clinicId, appointmentId, expectedVersion
        );
        if (existing && req.body?.substituir !== true) {
            await connection.commit();
            if (existing.estado === 'preparada') {
                return res.status(200).json({
                    confirmacao_id: Number(existing.id), estado: 'preparada', idempotente: true,
                    whatsapp_url: null,
                    message: 'Já existe uma solicitação pendente. Nenhum novo link foi criado ou revogado.'
                });
            }
            return res.status(409).json({
                error: 'Já existe uma resposta para este horário. Use a ação explícita de nova solicitação.'
            });
        }
        if (existing?.estado === 'expirada') {
            const [expired] = await connection.execute(`UPDATE confirmacoes_consulta
                SET estado = 'expirada' WHERE id = ? AND clinica_id = ? AND estado = 'preparada'`,
            [existing.id, req.tenant.clinicId]);
            if (expired.affectedRows === 1) {
                await connection.execute(`INSERT INTO confirmacoes_consulta_eventos
                    (clinica_id, confirmacao_id, evento, origem, usuario_id)
                    VALUES (?, ?, 'expirada', 'sistema', ?)`,
                [req.tenant.clinicId, existing.id, req.userId]);
            }
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
            confirmacao_id: confirmationId, canal: 'whatsapp', estado_entrega: 'nao_enviado',
            substituiu_confirmacao_id: existing ? Number(existing.id) : null
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
        const existing = await currentConfirmation(
            connection, req.tenant.clinicId, appointmentId, expectedVersion
        );
        const terminal = existing && ['confirmada', 'recusada'].includes(existing.estado)
            ? existing
            : existing
                ? await latestTerminalConfirmation(
                    connection, req.tenant.clinicId, appointmentId, expectedVersion, existing.id
                )
                : null;
        if (terminal) {
            if (terminal.estado === answer) {
                if (existing?.estado === 'preparada') {
                    await revokePrepared(
                        connection, req.tenant.clinicId, appointmentId,
                        'resposta_ja_registrada', req.userId
                    );
                }
                await connection.commit();
                return res.status(200).json({
                    estado: answer, idempotente: true,
                    message: 'Esta resposta já estava registrada. Nenhum registro duplicado foi criado.'
                });
            }
            if (req.body?.corrigir !== true) {
                await connection.rollback();
                return res.status(409).json({
                    error: 'A resposta diverge do registro atual. Confirme explicitamente a correção administrativa.'
                });
            }
        }
        await revokePrepared(connection, req.tenant.clinicId, appointmentId, 'resposta_manual', req.userId);
        const [insert] = await connection.execute(`
            INSERT INTO confirmacoes_consulta (
                clinica_id, consulta_id, consulta_versao, canal, estado,
                solicitado_por_usuario_id, respondido_por_usuario_id, respondido_em
            ) VALUES (?, ?, ?, 'manual', ?, ?, ?, UTC_TIMESTAMP(6))
        `, [req.tenant.clinicId, appointmentId, expectedVersion, answer, req.userId, req.userId]);
        await connection.execute(`INSERT INTO confirmacoes_consulta_eventos
            (clinica_id, confirmacao_id, evento, origem, usuario_id, metadados)
            VALUES (?, ?, ?, 'operador', ?, ?)`, [
            req.tenant.clinicId, insert.insertId, answer, req.userId,
            terminal && terminal.estado !== answer
                ? JSON.stringify({ corrige_confirmacao_id: Number(terminal.id) }) : null
        ]);
        await audit(connection, req.tenant.clinicId, req.userId,
            terminal && terminal.estado !== answer ? 'confirmacao_corrigida_manual' : `confirmacao_${answer}_manual`,
            appointmentId, terminal && terminal.estado !== answer
                ? { anterior: terminal.estado, atual: answer, corrige_confirmacao_id: Number(terminal.id) } : {});
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
    const tokenHash = hashConfirmationToken(req.body?.token);
    if (!tokenHash) return res.status(404).json({ error: 'Este link não está disponível.' });
    try {
        const [rows] = await pool.execute(`
            SELECT cc.estado, cc.expira_em, cc.consulta_versao, c.versao, c.status,
                   c.inicio_em, clinic.nome AS clinica_nome, clinic.timezone
            FROM confirmacoes_consulta cc
            JOIN consultas c ON c.clinica_id = cc.clinica_id AND c.id = cc.consulta_id
            JOIN clinicas clinic ON clinic.id = cc.clinica_id AND clinic.status = 'ativa'
            WHERE cc.token_hash = ? LIMIT 1
        `, [tokenHash]);
        const item = rows[0];
        if (!item) return res.status(404).json({ error: 'Este link não está disponível.' });
        const expired = new Date(item.expira_em) <= new Date();
        const active = item.estado === 'preparada' && !expired && utcDate(item.inicio_em) > new Date()
            && Number(item.consulta_versao) === Number(item.versao)
            && ['agendada', 'confirmada'].includes(item.status);
        if (!active) return res.status(404).json({ error: 'Este link não está disponível.' });
        return res.status(200).json({
            clinica_nome: item.clinica_nome,
            inicio_local: utcToLocal(item.inicio_em, item.timezone),
            pode_responder: true
        });
    } catch (error) {
        logFailure('inspect_public', error);
        return res.status(500).json({ error: 'Erro ao consultar confirmação.' });
    }
};

exports.respondPublic = async (req, res) => {
    const tokenHash = hashConfirmationToken(req.body?.token);
    const answer = req.body?.resposta;
    if (!RESPONSES.has(answer)) return res.status(400).json({ error: 'Resposta inválida.' });
    if (!tokenHash) return res.status(404).json({ error: 'Este link não está disponível.' });
    let connection;
    try {
        connection = await pool.getConnection(); await connection.beginTransaction();
        const [references] = await connection.execute(`
            SELECT clinica_id, consulta_id FROM confirmacoes_consulta WHERE token_hash = ? LIMIT 1
        `, [tokenHash]);
        const reference = references[0];
        if (!reference) {
            await connection.rollback();
            return res.status(404).json({ error: 'Este link não está disponível.' });
        }
        await connection.execute(`SELECT id FROM consultas
            WHERE clinica_id = ? AND id = ? LIMIT 1 FOR UPDATE`,
        [reference.clinica_id, reference.consulta_id]);
        const [rows] = await connection.execute(`
            SELECT cc.id, cc.clinica_id, cc.consulta_id, cc.consulta_versao, cc.estado,
                   cc.expira_em, c.versao, c.status, c.inicio_em
            FROM confirmacoes_consulta cc
            JOIN consultas c ON c.clinica_id = cc.clinica_id AND c.id = cc.consulta_id
            JOIN clinicas clinic ON clinic.id = cc.clinica_id AND clinic.status = 'ativa'
            WHERE cc.token_hash = ? LIMIT 1 FOR UPDATE
        `, [tokenHash]);
        const item = rows[0];
        if (!item) { await connection.rollback(); return res.status(404).json({ error: 'Este link não está disponível.' }); }
        if (item.estado !== 'preparada' || new Date(item.expira_em) <= new Date()
            || Number(item.consulta_versao) !== Number(item.versao) || utcDate(item.inicio_em) <= new Date()
            || !['agendada', 'confirmada'].includes(item.status)) {
            await connection.rollback();
            return res.status(409).json({ error: 'Este link não está disponível.' });
        }
        const terminal = await latestTerminalConfirmation(
            connection, item.clinica_id, item.consulta_id, item.consulta_versao, item.id
        );
        if (terminal) {
            await connection.execute(`UPDATE confirmacoes_consulta
                SET estado = 'revogada', revogado_em = UTC_TIMESTAMP(6),
                    motivo_revogacao = 'resposta_anterior_preservada'
                WHERE id = ? AND estado = 'preparada'`, [item.id]);
            await connection.execute(`INSERT INTO confirmacoes_consulta_eventos
                (clinica_id, confirmacao_id, evento, origem, metadados)
                VALUES (?, ?, 'revogada', 'sistema', ?)`, [
                item.clinica_id, item.id, JSON.stringify({ resposta_preservada_id: Number(terminal.id) })
            ]);
            await audit(connection, item.clinica_id, null,
                terminal.estado === answer
                    ? 'confirmacao_resposta_publica_idempotente'
                    : 'confirmacao_resposta_publica_conflitante_bloqueada',
                item.consulta_id, { confirmacao_id: Number(item.id), resposta_preservada_id: Number(terminal.id) });
            await connection.commit();
            if (terminal.estado === answer) {
                return res.status(200).json({
                    estado: answer, idempotente: true,
                    message: 'Esta resposta já estava registrada. Nenhuma resposta duplicada foi criada.'
                });
            }
            return res.status(409).json({
                error: 'Já existe outra resposta registrada. Entre em contato com a clínica para corrigi-la.'
            });
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
                : 'Informação registrada. Entre em contato com a clínica para tratar do reagendamento.'
        });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('respond_public', error);
        return res.status(500).json({ error: 'Erro ao registrar confirmação.' });
    } finally { connection?.release(); }
};

exports.revokePrepared = revokePrepared;
exports.whatsappNumber = whatsappNumber;
