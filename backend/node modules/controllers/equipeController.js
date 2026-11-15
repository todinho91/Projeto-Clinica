const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const mailer = require('../services/invitation-mailer');
const { createInvitationToken, hashInvitationToken } = require('../support/invitation-token');
const { invitation } = require('../config/environment');

const ROLES = new Set(['administrador', 'secretaria', 'profissional', 'paciente']);
const PROFILE_TABLES = Object.freeze({ profissional: 'profissionais', paciente: 'pacientes' });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function id(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizedEmail(value) {
    if (typeof value !== 'string') return null;
    const email = value.trim().toLowerCase();
    return email.length <= 254 && EMAIL.test(email) ? email : null;
}

function mayManage(actorRole, targetRole) {
    return actorRole === 'administrador' || (actorRole === 'secretaria' && targetRole === 'profissional');
}

function logFailure(event, error) {
    console.error(`[equipe] ${event}`, { code: error?.code || 'UNEXPECTED' });
}

async function authorizedOperator(connection, req) {
    const [rows] = await connection.execute(`
        SELECT cu.papel, cu.status AS vinculo_status,
               u.status AS usuario_status, c.status AS clinica_status
        FROM clinica_usuarios cu
        JOIN usuarios u ON u.id = cu.usuario_id
        JOIN clinicas c ON c.id = cu.clinica_id
        WHERE cu.clinica_id = ? AND cu.usuario_id = ? AND cu.papel = ?
          AND cu.sessao_versao = ?
        FOR UPDATE
    `, [req.tenant.clinicId, req.userId, req.tenant.role, req.auth?.membershipVersion]);
    const actor = rows[0];
    if (!actor || actor.papel !== req.tenant.role || actor.vinculo_status !== 'ativo'
        || actor.usuario_status !== 'ativo' || actor.clinica_status !== 'ativa') return null;
    return actor;
}

async function hasRequiredProfile(connection, clinicId, userId, role) {
    const table = PROFILE_TABLES[role];
    if (!table) return true;
    const [profiles] = await connection.execute(
        `SELECT id FROM ${table} WHERE clinica_id = ? AND usuario_id = ? LIMIT 1 FOR UPDATE`,
        [clinicId, userId]
    );
    return profiles.length > 0;
}

function deliveryPresentation(delivery) {
    if (delivery.status === 'accepted_by_provider') {
        return {
            entrega: 'aceita_pelo_provedor',
            message: 'Convite criado; solicitação aceita pelo provedor. A entrega ainda não foi confirmada.'
        };
    }
    if (delivery.status === 'delivered') {
        return { entrega: 'confirmada', message: 'Convite criado e entrega confirmada pelo provedor.' };
    }
    if (delivery.status === 'not_configured') {
        return {
            entrega: 'nao_configurada',
            message: 'Convite criado; envio de e-mail não configurado.'
        };
    }
    return { entrega: 'falhou', message: 'Convite criado, mas a solicitação de envio falhou.' };
}

async function recordDelivery(invitationId, clinicId, delivery) {
    const allowed = new Set(['not_configured', 'accepted_by_provider', 'delivered', 'failed']);
    const status = allowed.has(delivery.status) ? delivery.status : 'failed';
    await pool.execute(`
        UPDATE convites_clinica
        SET envio_status = ?, provedor_mensagem_id = ?, envio_atualizado_em = UTC_TIMESTAMP(6)
        WHERE id = ? AND clinica_id = ?
    `, [status, delivery.providerMessageId ?? null, invitationId, clinicId]);
}

async function finishDelivery(req, invitationId, mailPayload) {
    const delivery = await mailer.sendInvitation(mailPayload);
    try {
        await recordDelivery(invitationId, req.tenant.clinicId, delivery);
    } catch (error) {
        logFailure('record_delivery_failed', error);
    }
    return deliveryPresentation(delivery);
}

async function invitationRateCheck(connection, clinicId, linkId, creatorId) {
    const [recentLink] = await connection.execute(`
        SELECT id, criado_em FROM convites_clinica
        WHERE clinica_id = ? AND clinica_usuario_id = ?
          AND criado_em >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 HOUR)
        ORDER BY id DESC LIMIT 6 FOR UPDATE
    `, [clinicId, linkId]);
    if (recentLink.length >= 5) return true;
    if (recentLink[0] && new Date(recentLink[0].criado_em).getTime() > Date.now() - 60_000) return true;
    const [recentActor] = await connection.execute(`
        SELECT id FROM convites_clinica
        WHERE clinica_id = ? AND criado_por_usuario_id = ?
          AND criado_em >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 HOUR)
        LIMIT 51 FOR UPDATE
    `, [clinicId, creatorId]);
    return recentActor.length >= 50;
}

async function audit(connection, req, action, entity, entityId, metadata = {}) {
    await connection.execute(`
        INSERT INTO auditoria (clinica_id, usuario_id, acao, entidade_tipo, entidade_id, metadados)
        VALUES (?, ?, ?, ?, ?, ?)
    `, [req.tenant.clinicId, req.userId, action, entity, entityId, JSON.stringify(metadata)]);
}

async function issueInvitation(connection, req, link, email, role) {
    const token = createInvitationToken();
    const tokenHash = hashInvitationToken(token);
    await connection.execute(`
        UPDATE convites_clinica
        SET status = 'revogado', revogado_em = UTC_TIMESTAMP(6)
        WHERE clinica_id = ? AND clinica_usuario_id = ? AND status = 'pendente'
    `, [req.tenant.clinicId, link.id]);
    const [result] = await connection.execute(`
        INSERT INTO convites_clinica (
            clinica_id, clinica_usuario_id, email_normalizado, papel,
            token_hash, expira_em, criado_por_usuario_id
        ) VALUES (?, ?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? HOUR), ?)
    `, [req.tenant.clinicId, link.id, email, role, tokenHash, invitation.ttlHours, req.userId]);
    return { id: Number(result.insertId), token };
}

exports.list = async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT cu.id, cu.usuario_id, u.nome, u.email, cu.papel, cu.status,
                   i.id AS convite_id, i.status AS convite_status, i.expira_em, i.criado_em,
                   i.envio_status
            FROM clinica_usuarios cu
            JOIN usuarios u ON u.id = cu.usuario_id
            LEFT JOIN convites_clinica i ON i.id = (
                SELECT i2.id FROM convites_clinica i2
                WHERE i2.clinica_id = cu.clinica_id AND i2.clinica_usuario_id = cu.id
                ORDER BY i2.id DESC LIMIT 1
            )
            WHERE cu.clinica_id = ?
            ORDER BY u.nome, cu.id
        `, [req.tenant.clinicId]);
        return res.status(200).json(rows.map((row) => ({ ...row, id: Number(row.id) })));
    } catch (error) {
        logFailure('list_failed', error);
        return res.status(500).json({ error: 'Erro ao listar equipe.' });
    }
};

exports.createInvitation = async (req, res) => {
    const email = normalizedEmail(req.body?.email);
    const role = req.body?.papel;
    if (!email || !ROLES.has(role)) return res.status(400).json({ error: 'E-mail ou papel inválido.' });
    if (!mayManage(req.tenant.role, role)) return res.status(403).json({ error: 'Papel não autorizado.' });
    let connection;
    let issued;
    let clinicName;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const actor = await authorizedOperator(connection, req);
        if (!actor || !mayManage(actor.papel, role)) {
            await connection.rollback();
            return res.status(403).json({ error: 'Operador não autorizado ou sessão desatualizada.' });
        }
        const [clinicRows] = await connection.execute(
            'SELECT nome, status FROM clinicas WHERE id = ? FOR UPDATE', [req.tenant.clinicId]
        );
        clinicName = clinicRows[0]?.nome;
        if (!clinicName || clinicRows[0].status !== 'ativa') {
            await connection.rollback();
            return res.status(409).json({ error: 'A clínica não está ativa.' });
        }
        const [userRows] = await connection.execute(
            'SELECT id, status, motivo_bloqueio FROM usuarios WHERE email = ? LIMIT 1 FOR UPDATE', [email]
        );
        const existingUser = userRows[0];
        let userId = existingUser?.id;
        if (!userId && PROFILE_TABLES[role]) {
            await connection.rollback();
            return res.status(409).json({
                error: role === 'profissional'
                    ? 'Conclua primeiro o cadastro do profissional na tela Profissionais.'
                    : 'O paciente deve possuir cadastro clínico antes de receber convite.',
                code: 'CLINICAL_PROFILE_REQUIRED'
            });
        }
        if (!userId) {
            const name = typeof req.body?.nome === 'string' ? req.body.nome.trim() : '';
            if (name.length < 2 || name.length > 160) {
                await connection.rollback();
                return res.status(400).json({ error: 'Nome é obrigatório para uma nova conta.' });
            }
            const hash = await bcrypt.hash(createInvitationToken(), 12);
            const [created] = await connection.execute(`
                INSERT INTO usuarios (nome, email, senha_hash, status, motivo_bloqueio)
                VALUES (?, ?, ?, 'bloqueado', 'ativacao_pendente')
            `, [name, email, hash]);
            userId = created.insertId;
        }
        const [existing] = await connection.execute(`
            SELECT id, papel, status FROM clinica_usuarios
            WHERE clinica_id = ? AND usuario_id = ? FOR UPDATE
        `, [req.tenant.clinicId, userId]);
        if (existingUser?.status === 'inativo'
            || (existingUser?.status === 'bloqueado'
                && existingUser.motivo_bloqueio !== 'ativacao_pendente')) {
            await connection.rollback();
            return res.status(409).json({ error: 'A conta existente não está disponível para convite.' });
        }
        if (existing[0]?.status === 'ativo') {
            await connection.rollback();
            return res.status(409).json({ error: 'Usuário já possui vínculo ativo nesta clínica.' });
        }
        if (existing[0] && existing[0].papel !== role) {
            await connection.rollback();
            return res.status(409).json({ error: 'O vínculo existente possui outro papel. Altere-o pelo fluxo administrativo autorizado.' });
        }
        if (!(await hasRequiredProfile(connection, req.tenant.clinicId, userId, role))) {
            await connection.rollback();
            return res.status(409).json({
                error: role === 'profissional'
                    ? 'Conclua primeiro o cadastro do profissional na tela Profissionais.'
                    : 'O paciente deve possuir cadastro clínico antes de receber convite.',
                code: 'CLINICAL_PROFILE_REQUIRED'
            });
        }
        let linkId = existing[0]?.id;
        if (!linkId) {
            const [link] = await connection.execute(`
                INSERT INTO clinica_usuarios (clinica_id, usuario_id, papel, status)
                VALUES (?, ?, ?, 'convite_pendente')
            `, [req.tenant.clinicId, userId, role]);
            linkId = link.insertId;
        } else if (existing[0].status === 'inativo') {
            await connection.execute(`
                UPDATE clinica_usuarios
                SET status = 'convite_pendente', sessao_versao = sessao_versao + 1
                WHERE id = ? AND clinica_id = ? AND status = 'inativo'
            `, [linkId, req.tenant.clinicId]);
            await audit(connection, req, 'vinculo_reativacao_iniciada', 'clinica_usuario', linkId, {
                papel: role,
                status_anterior: 'inativo'
            });
        } else if (existing[0].status !== 'convite_pendente') {
            await connection.rollback();
            return res.status(409).json({ error: 'Estado do vínculo incompatível com convite.' });
        }
        if (await invitationRateCheck(connection, req.tenant.clinicId, linkId, req.userId)) {
            await connection.rollback();
            return res.status(429).json({ error: 'Limite de convites atingido. Tente novamente mais tarde.' });
        }
        issued = await issueInvitation(connection, req, { id: linkId }, email, role);
        await audit(connection, req, 'convite_criado', 'convite_clinica', issued.id, { papel: role });
        await connection.commit();
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('create_invitation_failed', error);
        return res.status(500).json({ error: 'Erro ao criar convite.' });
    } finally { connection?.release(); }

    const delivery = await finishDelivery(req, issued.id, {
        recipient: email, clinicName, role, token: issued.token
    });
    return res.status(201).json({
        id: issued.id,
        message: delivery.message,
        entrega: delivery.entrega
    });
};

exports.reissue = async (req, res) => {
    const invitationId = id(req.params.id);
    if (!invitationId) return res.status(400).json({ error: 'Convite inválido.' });
    let connection;
    let issued;
    let target;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const actor = await authorizedOperator(connection, req);
        if (!actor) {
            await connection.rollback();
            return res.status(403).json({ error: 'Operador não autorizado ou sessão desatualizada.' });
        }
        const [rows] = await connection.execute(`
            SELECT i.*, c.nome AS clinica_nome, c.status AS clinica_status,
                   cu.status AS vinculo_status, cu.papel AS vinculo_papel,
                   u.status AS usuario_status, u.motivo_bloqueio, u.email AS usuario_email
            FROM convites_clinica i
            JOIN clinicas c ON c.id = i.clinica_id
            JOIN clinica_usuarios cu ON cu.id = i.clinica_usuario_id AND cu.clinica_id = i.clinica_id
            JOIN usuarios u ON u.id = cu.usuario_id
            WHERE i.id = ? AND i.clinica_id = ? FOR UPDATE
        `, [invitationId, req.tenant.clinicId]);
        target = rows[0];
        if (!target) { await connection.rollback(); return res.status(404).json({ error: 'Convite não encontrado.' }); }
        if (!mayManage(actor.papel, target.papel)) { await connection.rollback(); return res.status(403).json({ error: 'Papel não autorizado.' }); }
        if (target.status !== 'pendente') {
            await connection.rollback();
            return res.status(409).json({ error: 'Somente convites pendentes podem ser reenviados.' });
        }
        if (await invitationRateCheck(
            connection, req.tenant.clinicId, target.clinica_usuario_id, req.userId
        )) {
            await connection.rollback();
            return res.status(429).json({ error: 'Limite de reenvios atingido. Tente novamente mais tarde.' });
        }
        if (target.clinica_status !== 'ativa' || target.vinculo_status !== 'convite_pendente'
            || target.vinculo_papel !== target.papel
            || target.email_normalizado !== String(target.usuario_email).toLowerCase()
            || target.usuario_status === 'inativo'
            || (target.usuario_status === 'bloqueado'
                && target.motivo_bloqueio !== 'ativacao_pendente')) {
            await connection.rollback();
            return res.status(409).json({ error: 'Identidade, vínculo ou clínica não estão aptos ao reenvio.' });
        }
        issued = await issueInvitation(
            connection, req, { id: target.clinica_usuario_id }, target.email_normalizado, target.papel
        );
        await audit(connection, req, 'convite_reenviado', 'convite_clinica', issued.id, { anterior_id: invitationId });
        await connection.commit();
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('reissue_invitation_failed', error);
        return res.status(500).json({ error: 'Erro ao reenviar convite.' });
    } finally { connection?.release(); }
    const delivery = await finishDelivery(req, issued.id, {
        recipient: target.email_normalizado,
        clinicName: target.clinica_nome,
        role: target.papel,
        token: issued.token
    });
    return res.status(201).json({ id: issued.id, message: delivery.message, entrega: delivery.entrega });
};

exports.revoke = async (req, res) => {
    const invitationId = id(req.params.id);
    if (!invitationId) return res.status(400).json({ error: 'Convite inválido.' });
    let connection;
    try {
        connection = await pool.getConnection(); await connection.beginTransaction();
        const actor = await authorizedOperator(connection, req);
        if (!actor) { await connection.rollback(); return res.status(403).json({ error: 'Operador não autorizado ou sessão desatualizada.' }); }
        const [rows] = await connection.execute(`SELECT id, papel, status FROM convites_clinica WHERE id = ? AND clinica_id = ? FOR UPDATE`, [invitationId, req.tenant.clinicId]);
        const target = rows[0];
        if (!target) { await connection.rollback(); return res.status(404).json({ error: 'Convite não encontrado.' }); }
        if (!mayManage(actor.papel, target.papel)) { await connection.rollback(); return res.status(403).json({ error: 'Papel não autorizado.' }); }
        if (target.status !== 'pendente') { await connection.rollback(); return res.status(409).json({ error: 'Convite não está pendente.' }); }
        await connection.execute(`UPDATE convites_clinica SET status='revogado', revogado_em=UTC_TIMESTAMP(6) WHERE id=?`, [invitationId]);
        await audit(connection, req, 'convite_revogado', 'convite_clinica', invitationId);
        await connection.commit();
        return res.status(200).json({ message: 'Convite revogado.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('revoke_invitation_failed', error);
        return res.status(500).json({ error: 'Erro ao revogar convite.' });
    } finally { connection?.release(); }
};

exports.inspectInvitation = async (req, res) => {
    const hash = hashInvitationToken(req.params.token);
    if (!hash) return res.status(404).json({ error: 'Convite inválido.' });
    try {
        const [rows] = await pool.execute(`
            SELECT c.nome AS clinica, c.status AS clinica_status, i.papel, i.expira_em, i.status,
                   cu.status AS vinculo_status, cu.papel AS vinculo_papel,
                   u.status AS usuario_status, u.motivo_bloqueio,
                   CASE WHEN u.status = 'bloqueado' AND u.motivo_bloqueio = 'ativacao_pendente' THEN 1 ELSE 0 END AS requer_senha
            FROM convites_clinica i
            JOIN clinicas c ON c.id=i.clinica_id
            JOIN clinica_usuarios cu ON cu.id=i.clinica_usuario_id AND cu.clinica_id=i.clinica_id
            JOIN usuarios u ON u.id=cu.usuario_id
            WHERE i.token_hash=? LIMIT 1
        `, [hash]);
        const item = rows[0];
        if (!item || item.status !== 'pendente' || item.vinculo_status !== 'convite_pendente'
            || item.vinculo_papel !== item.papel || item.clinica_status !== 'ativa'
            || item.usuario_status === 'inativo'
            || (item.usuario_status === 'bloqueado'
                && item.motivo_bloqueio !== 'ativacao_pendente')
            || new Date(item.expira_em) <= new Date()) {
            return res.status(410).json({ error: 'Convite expirado, revogado ou já utilizado.' });
        }
        return res.status(200).json({ clinica: item.clinica, papel: item.papel, expira_em: item.expira_em, requer_senha: Boolean(item.requer_senha) });
    } catch (error) {
        logFailure('inspect_invitation_failed', error);
        return res.status(500).json({ error: 'Erro ao consultar convite.' });
    }
};

exports.acceptInvitation = async (req, res) => {
    const hash = hashInvitationToken(req.params.token);
    const password = req.body?.senha;
    if (!hash) return res.status(404).json({ error: 'Convite inválido.' });
    let connection;
    try {
        connection = await pool.getConnection(); await connection.beginTransaction();
        const [rows] = await connection.execute(`
            SELECT i.id, i.clinica_id, i.papel, i.status, i.expira_em,
                   cu.id AS vinculo_id, cu.usuario_id, cu.status AS vinculo_status,
                   cu.papel AS vinculo_papel,
                   u.status AS usuario_status, u.motivo_bloqueio,
                   u.email AS usuario_email, i.email_normalizado,
                   c.status AS clinica_status
            FROM convites_clinica i
            JOIN clinica_usuarios cu ON cu.id=i.clinica_usuario_id AND cu.clinica_id=i.clinica_id
            JOIN usuarios u ON u.id=cu.usuario_id
            JOIN clinicas c ON c.id=i.clinica_id
            WHERE i.token_hash=? FOR UPDATE
        `, [hash]);
        const target = rows[0];
        if (!target || target.status !== 'pendente' || target.vinculo_status !== 'convite_pendente'
            || target.vinculo_papel !== target.papel || target.clinica_status !== 'ativa'
            || target.email_normalizado !== String(target.usuario_email).toLowerCase()
            || target.usuario_status === 'inativo'
            || (target.usuario_status === 'bloqueado'
                && target.motivo_bloqueio !== 'ativacao_pendente')
            || new Date(target.expira_em) <= new Date()) {
            await connection.rollback(); return res.status(410).json({ error: 'Convite expirado, revogado ou já utilizado.' });
        }
        if (!(await hasRequiredProfile(
            connection, target.clinica_id, target.usuario_id, target.papel
        ))) {
            await connection.rollback();
            return res.status(409).json({ error: 'O cadastro clínico precisa ser concluído antes da ativação.' });
        }
        if (target.usuario_status === 'bloqueado') {
            if (typeof password !== 'string' || password.length < 12 || password.length > 200) {
                await connection.rollback(); return res.status(400).json({ error: 'Crie uma senha com pelo menos 12 caracteres.' });
            }
            const passwordHash = await bcrypt.hash(password, 12);
            await connection.execute(`
                UPDATE usuarios
                SET senha_hash=?, status='ativo', motivo_bloqueio='nenhum'
                WHERE id=? AND status='bloqueado' AND motivo_bloqueio='ativacao_pendente'
            `, [passwordHash, target.usuario_id]);
        } else if (req.userId !== Number(target.usuario_id)) {
            await connection.rollback(); return res.status(401).json({ error: 'Entre na conta convidada para aceitar este convite.' });
        }
        await connection.execute(`
            UPDATE clinica_usuarios
            SET status='ativo', sessao_versao=sessao_versao + 1
            WHERE id=? AND clinica_id=? AND status='convite_pendente'
        `, [target.vinculo_id, target.clinica_id]);
        await connection.execute(`UPDATE convites_clinica SET status='aceito', aceito_em=UTC_TIMESTAMP(6) WHERE id=?`, [target.id]);
        await connection.execute(`
            INSERT INTO auditoria (clinica_id, usuario_id, acao, entidade_tipo, entidade_id, metadados)
            VALUES (?, ?, 'convite_aceito', 'convite_clinica', ?, ?)
        `, [target.clinica_id, target.usuario_id, target.id, JSON.stringify({ papel: target.papel })]);
        await connection.commit();
        return res.status(200).json({ message: 'Convite aceito. O acesso à clínica está ativo.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('accept_invitation_failed', error);
        return res.status(500).json({ error: 'Erro ao aceitar convite.' });
    } finally { connection?.release(); }
};

async function changeLink(req, res, mode) {
    const linkId = id(req.params.id);
    const value = mode === 'role' ? req.body?.papel : req.body?.status;
    if (!linkId || (mode === 'role' ? !ROLES.has(value) : !['ativo', 'inativo'].includes(value))) {
        return res.status(400).json({ error: 'Alteração inválida.' });
    }
    if (mode === 'role' && req.tenant.role !== 'administrador') return res.status(403).json({ error: 'Somente administradores alteram papéis.' });
    let connection;
    try {
        connection = await pool.getConnection(); await connection.beginTransaction();
        const actor = await authorizedOperator(connection, req);
        if (!actor) { await connection.rollback(); return res.status(403).json({ error: 'Operador não autorizado ou sessão desatualizada.' }); }
        const [rows] = await connection.execute(`SELECT id, usuario_id, papel, status FROM clinica_usuarios WHERE id=? AND clinica_id=? FOR UPDATE`, [linkId, req.tenant.clinicId]);
        const target = rows[0];
        if (!target) { await connection.rollback(); return res.status(404).json({ error: 'Vínculo não encontrado.' }); }
        if (!mayManage(actor.papel, target.papel) || (mode === 'role' && !mayManage(actor.papel, value))) {
            await connection.rollback(); return res.status(403).json({ error: 'Alteração não autorizada.' });
        }
        if (target.status === 'convite_pendente') {
            await connection.rollback();
            return res.status(409).json({ error: 'O vínculo pendente só pode mudar pelo aceite ou revogação do convite.' });
        }
        if (mode === 'role' && ['profissional', 'paciente'].includes(value)) {
            const table = value === 'profissional' ? 'profissionais' : 'pacientes';
            const [profiles] = await connection.execute(
                `SELECT id FROM ${table} WHERE clinica_id=? AND usuario_id=? LIMIT 1 FOR UPDATE`,
                [req.tenant.clinicId, target.usuario_id]
            );
            if (profiles.length === 0) {
                await connection.rollback();
                return res.status(409).json({ error: `O usuário não possui perfil de ${value} nesta clínica.` });
            }
        }
        if (mode === 'status' && value === 'ativo') {
            if (target.status === 'convite_pendente') {
                await connection.rollback();
                return res.status(409).json({ error: 'O vínculo pendente deve ser ativado pelo aceite do convite.' });
            }
            const [users] = await connection.execute(
                'SELECT status FROM usuarios WHERE id = ? FOR UPDATE', [target.usuario_id]
            );
            if (users[0]?.status !== 'ativo') {
                await connection.rollback();
                return res.status(409).json({ error: 'A identidade global não está ativa.' });
            }
            if (!(await hasRequiredProfile(
                connection, req.tenant.clinicId, target.usuario_id, target.papel
            ))) {
                await connection.rollback();
                return res.status(409).json({ error: 'O cadastro clínico precisa ser concluído antes da reativação.' });
            }
        }
        const removesAdmin = target.papel === 'administrador' && target.status === 'ativo'
            && ((mode === 'role' && value !== 'administrador') || (mode === 'status' && value !== 'ativo'));
        if (removesAdmin) {
            const [admins] = await connection.execute(`
                SELECT cu.id
                FROM clinica_usuarios cu
                JOIN usuarios u ON u.id = cu.usuario_id
                WHERE cu.clinica_id=? AND cu.papel='administrador' AND cu.status='ativo'
                  AND u.status='ativo' AND cu.id <> ?
                FOR UPDATE
            `, [req.tenant.clinicId, linkId]);
            if (admins.length === 0) { await connection.rollback(); return res.status(409).json({ error: 'A clínica deve manter ao menos um administrador ativo.' }); }
        }
        const column = mode === 'role' ? 'papel' : 'status';
        await connection.execute(`
            UPDATE clinica_usuarios
            SET ${column}=?, sessao_versao=sessao_versao + 1
            WHERE id=? AND clinica_id=?
        `, [value, linkId, req.tenant.clinicId]);
        if (mode === 'status' && value === 'inativo') {
            await connection.execute(`UPDATE convites_clinica SET status='revogado', revogado_em=UTC_TIMESTAMP(6) WHERE clinica_id=? AND clinica_usuario_id=? AND status='pendente'`, [req.tenant.clinicId, linkId]);
        }
        await audit(connection, req, mode === 'role' ? 'vinculo_papel_alterado' : 'vinculo_status_alterado', 'clinica_usuario', linkId, { valor: value });
        await connection.commit();
        return res.status(200).json({ message: 'Vínculo atualizado.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('update_link_failed', error);
        return res.status(500).json({ error: 'Erro ao atualizar vínculo.' });
    } finally { connection?.release(); }
}

exports.updateStatus = (req, res) => changeLink(req, res, 'status');
exports.updateRole = (req, res) => changeLink(req, res, 'role');
exports._private = { authorizedOperator, deliveryPresentation, hasRequiredProfile, mayManage, normalizedEmail };
