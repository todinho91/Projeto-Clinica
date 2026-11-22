const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const mailer = require('../services/invitation-mailer');
const { invitation } = require('../config/environment');
const { createInvitationToken, hashInvitationToken } = require('../support/invitation-token');

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function text(value, min, max) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length >= min && normalized.length <= max ? normalized : null;
}

function email(value) {
    const normalized = text(value, 3, 254)?.toLowerCase();
    return normalized && EMAIL.test(normalized) ? normalized : null;
}

function slug(value) {
    const normalized = text(value, 3, 100)?.toLowerCase();
    return normalized && SLUG.test(normalized) ? normalized : null;
}

function timezone(value) {
    const normalized = text(value, 1, 64);
    if (!normalized) return null;
    try {
        new Intl.DateTimeFormat('pt-BR', { timeZone: normalized }).format(new Date());
        return normalized;
    } catch {
        return null;
    }
}

function logFailure(event, error) {
    console.error(`[clinicas] ${event}`, { code: error?.code || 'UNEXPECTED' });
}

function positiveId(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function platformOperator(executor, userId, lock = false) {
    const [rows] = await executor.execute(`
        SELECT op.id, op.status AS operador_status, u.status AS usuario_status
        FROM operadores_plataforma op
        JOIN usuarios u ON u.id = op.usuario_id
        WHERE op.usuario_id = ?${lock ? ' FOR UPDATE' : ''}
    `, [userId]);
    const operator = rows[0];
    if (!operator || operator.operador_status !== 'ativo' || operator.usuario_status !== 'ativo') {
        return null;
    }
    return { id: Number(operator.id) };
}

function deliveryPresentation(delivery) {
    if (delivery.status === 'accepted_by_provider') {
        return {
            entrega: 'aceita_pelo_provedor',
            message: 'Clínica criada e convite aceito pelo provedor; a entrega ainda não foi confirmada.'
        };
    }
    if (delivery.status === 'delivered') {
        return { entrega: 'confirmada', message: 'Clínica criada e convite entregue ao administrador.' };
    }
    if (delivery.status === 'not_configured') {
        return { entrega: 'nao_configurada', message: 'Clínica criada; envio de e-mail não configurado.' };
    }
    return { entrega: 'falhou', message: 'Clínica criada, mas a solicitação de envio do convite falhou.' };
}

function reissueDeliveryPresentation(delivery) {
    if (delivery.status === 'accepted_by_provider') {
        return {
            entrega: 'aceita_pelo_provedor',
            message: 'Novo convite criado e aceito pelo provedor; a entrega ainda não foi confirmada.'
        };
    }
    if (delivery.status === 'delivered') {
        return { entrega: 'confirmada', message: 'Novo convite criado e entrega confirmada.' };
    }
    if (delivery.status === 'not_configured') {
        return { entrega: 'nao_configurada', message: 'Novo convite criado; envio de e-mail não configurado.' };
    }
    return { entrega: 'falhou', message: 'Novo convite criado, mas a solicitação de envio falhou.' };
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

exports.capabilities = async (req, res) => {
    try {
        return res.status(200).json({
            provisionar_clinicas: Boolean(await platformOperator(pool, req.userId))
        });
    } catch (error) {
        logFailure('capabilities_failed', error);
        return res.status(500).json({ error: 'Erro ao verificar permissões da plataforma.' });
    }
};

exports.listPlatformClinics = async (req, res) => {
    try {
        if (!(await platformOperator(pool, req.userId))) {
            return res.status(403).json({ error: 'Operação restrita à plataforma.' });
        }
        const [rows] = await pool.execute(`
            SELECT c.id, c.nome, c.slug, c.timezone, c.status,
                   u.nome AS administrador_nome, u.email AS administrador_email,
                   cu.status AS administrador_status,
                   i.id AS convite_id, i.status AS convite_status,
                   i.expira_em AS convite_expira_em, i.envio_status AS convite_envio_status,
                   CASE WHEN i.criado_por_operador_id IS NOT NULL THEN 1 ELSE 0 END
                     AS convite_origem_plataforma
            FROM clinicas c
            LEFT JOIN clinica_usuarios cu
              ON cu.id = (
                SELECT cu2.id FROM clinica_usuarios cu2
                WHERE cu2.clinica_id = c.id AND cu2.papel = 'administrador'
                ORDER BY cu2.id LIMIT 1
              )
            LEFT JOIN usuarios u ON u.id = cu.usuario_id
            LEFT JOIN convites_clinica i
              ON i.id = (
                SELECT i2.id FROM convites_clinica i2
                WHERE i2.clinica_id = c.id AND i2.clinica_usuario_id = cu.id
                ORDER BY i2.id DESC LIMIT 1
              )
            ORDER BY c.nome, c.id
        `);
        return res.status(200).json(rows.map((row) => {
            const expired = row.convite_expira_em
                ? new Date(row.convite_expira_em).getTime() <= Date.now()
                : false;
            const failedDelivery = ['not_requested', 'not_configured', 'failed']
                .includes(row.convite_envio_status);
            return {
                ...row,
                id: Number(row.id),
                convite_id: row.convite_id === null ? null : Number(row.convite_id),
                convite_expirado: expired,
                pode_reenviar_convite: row.administrador_status === 'convite_pendente'
                    && row.convite_status === 'pendente'
                    && Boolean(row.convite_origem_plataforma)
                    && (expired || failedDelivery)
            };
        }));
    } catch (error) {
        logFailure('platform_list_failed', error);
        return res.status(500).json({ error: 'Erro ao listar clínicas.' });
    }
};

exports.reissueInitialInvitation = async (req, res) => {
    const clinicId = positiveId(req.params.clinicId);
    const invitationId = positiveId(req.params.invitationId);
    if (!clinicId || !invitationId) {
        return res.status(400).json({ error: 'Clínica ou convite inválido.' });
    }
    let connection;
    let issued;
    let target;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const operator = await platformOperator(connection, req.userId, true);
        if (!operator) {
            await connection.rollback();
            return res.status(403).json({ error: 'Operação restrita à plataforma.' });
        }
        const [rows] = await connection.execute(`
            SELECT i.id, i.clinica_id, i.clinica_usuario_id, i.email_normalizado,
                   i.papel, i.status, i.expira_em, i.envio_status,
                   i.criado_por_operador_id,
                   c.nome AS clinica_nome, c.status AS clinica_status,
                   cu.status AS vinculo_status, cu.papel AS vinculo_papel,
                   u.status AS usuario_status, u.motivo_bloqueio,
                   u.email AS usuario_email
            FROM convites_clinica i
            JOIN clinicas c ON c.id = i.clinica_id
            JOIN clinica_usuarios cu
              ON cu.id = i.clinica_usuario_id AND cu.clinica_id = i.clinica_id
            JOIN usuarios u ON u.id = cu.usuario_id
            WHERE i.id = ? AND i.clinica_id = ?
            FOR UPDATE
        `, [invitationId, clinicId]);
        target = rows[0];
        if (!target) {
            await connection.rollback();
            return res.status(404).json({ error: 'Convite inicial não encontrado nesta clínica.' });
        }
        if (target.status !== 'pendente') {
            await connection.rollback();
            return res.status(409).json({ error: 'Este convite já foi substituído, revogado ou aceito.' });
        }
        if (!target.criado_por_operador_id) {
            await connection.rollback();
            return res.status(409).json({ error: 'Este convite não pertence ao provisionamento inicial.' });
        }
        if (target.clinica_status !== 'ativa'
            || target.papel !== 'administrador'
            || target.vinculo_papel !== 'administrador'
            || target.vinculo_status !== 'convite_pendente'
            || target.email_normalizado !== String(target.usuario_email).toLowerCase()) {
            await connection.rollback();
            return res.status(409).json({ error: 'O primeiro administrador não está pendente de ativação.' });
        }
        if (target.usuario_status === 'inativo'
            || (target.usuario_status === 'bloqueado'
                && target.motivo_bloqueio !== 'ativacao_pendente')) {
            await connection.rollback();
            return res.status(409).json({ error: 'A identidade do administrador não está disponível para convite.' });
        }
        const expired = new Date(target.expira_em).getTime() <= Date.now();
        const failedDelivery = ['not_requested', 'not_configured', 'failed']
            .includes(target.envio_status);
        if (!expired && !failedDelivery) {
            await connection.rollback();
            return res.status(409).json({ error: 'O convite atual ainda está válido e não possui falha de envio.' });
        }
        const [recent] = await connection.execute(`
            SELECT id FROM convites_clinica
            WHERE clinica_id = ? AND clinica_usuario_id = ?
              AND criado_em >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 HOUR)
            LIMIT 6 FOR UPDATE
        `, [clinicId, target.clinica_usuario_id]);
        if (recent.length >= 5) {
            await connection.rollback();
            return res.status(429).json({ error: 'Limite de reenvios atingido. Tente novamente mais tarde.' });
        }
        await connection.execute(`
            UPDATE convites_clinica
            SET status = 'revogado', revogado_em = UTC_TIMESTAMP(6)
            WHERE clinica_id = ? AND clinica_usuario_id = ? AND status = 'pendente'
        `, [clinicId, target.clinica_usuario_id]);
        const token = createInvitationToken();
        const [result] = await connection.execute(`
            INSERT INTO convites_clinica (
                clinica_id, clinica_usuario_id, email_normalizado, papel,
                token_hash, expira_em, criado_por_usuario_id, criado_por_operador_id
            ) VALUES (?, ?, ?, 'administrador', ?,
                DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? HOUR), NULL, ?)
        `, [
            clinicId, target.clinica_usuario_id, target.email_normalizado,
            hashInvitationToken(token), invitation.ttlHours, operator.id
        ]);
        issued = { id: Number(result.insertId), token };
        await connection.execute(`
            INSERT INTO auditoria_plataforma (
                operador_plataforma_id, clinica_id, acao, entidade_tipo, entidade_id, metadados
            ) VALUES (?, ?, 'convite_inicial_reenviado', 'convite_clinica', ?, ?)
        `, [
            operator.id, clinicId, issued.id,
            JSON.stringify({ convite_anterior_id: invitationId })
        ]);
        await connection.commit();
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('initial_invitation_reissue_failed', error);
        return res.status(500).json({ error: 'Erro ao reenviar convite inicial.' });
    } finally {
        connection?.release();
    }

    const delivery = await mailer.sendInvitation({
        recipient: target.email_normalizado,
        clinicName: target.clinica_nome,
        role: 'administrador',
        token: issued.token
    });
    try {
        await recordDelivery(issued.id, clinicId, delivery);
    } catch (error) {
        logFailure('record_reissue_delivery_failed', error);
    }
    const presentation = reissueDeliveryPresentation(delivery);
    return res.status(201).json({
        convite_id: issued.id,
        entrega: presentation.entrega,
        message: presentation.message
    });
};

exports.provision = async (req, res) => {
    const clinicName = text(req.body?.nome, 2, 160);
    const clinicSlug = slug(req.body?.slug);
    const clinicTimezone = timezone(req.body?.timezone);
    const clinicStatus = req.body?.status;
    const adminName = text(req.body?.administrador_nome, 2, 160);
    const adminEmail = email(req.body?.administrador_email);
    if (!clinicName || !clinicSlug || !clinicTimezone || !adminName || !adminEmail) {
        return res.status(400).json({ error: 'Nome, slug, fuso e administrador devem ser válidos.' });
    }
    if (clinicStatus !== 'ativa') {
        return res.status(400).json({ error: 'A clínica deve iniciar ativa para permitir o aceite do convite.' });
    }

    let connection;
    let created;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const operator = await platformOperator(connection, req.userId, true);
        if (!operator) {
            await connection.rollback();
            return res.status(403).json({ error: 'Operação restrita à plataforma.' });
        }
        const [recent] = await connection.execute(`
            SELECT id FROM auditoria_plataforma
            WHERE operador_plataforma_id = ?
              AND acao = 'clinica_provisionada'
              AND criado_em >= DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 HOUR)
            LIMIT 21 FOR UPDATE
        `, [operator.id]);
        if (recent.length >= 20) {
            await connection.rollback();
            return res.status(429).json({ error: 'Limite de provisionamentos atingido. Tente novamente mais tarde.' });
        }

        const [duplicateClinics] = await connection.execute(
            'SELECT id FROM clinicas WHERE slug = ? LIMIT 1 FOR UPDATE',
            [clinicSlug]
        );
        if (duplicateClinics[0]) {
            await connection.rollback();
            return res.status(409).json({ error: 'Já existe uma clínica com este slug.' });
        }

        const [clinicResult] = await connection.execute(`
            INSERT INTO clinicas (nome, slug, timezone, status)
            VALUES (?, ?, ?, 'ativa')
        `, [clinicName, clinicSlug, clinicTimezone]);
        const clinicId = Number(clinicResult.insertId);

        const [users] = await connection.execute(`
            SELECT id, status, motivo_bloqueio
            FROM usuarios WHERE email = ? LIMIT 1 FOR UPDATE
        `, [adminEmail]);
        let userId = users[0]?.id;
        if (users[0]?.status === 'inativo'
            || (users[0]?.status === 'bloqueado'
                && users[0].motivo_bloqueio !== 'ativacao_pendente')) {
            await connection.rollback();
            return res.status(409).json({ error: 'A conta do administrador não está disponível para convite.' });
        }
        if (!userId) {
            const placeholderHash = await bcrypt.hash(createInvitationToken(), 12);
            const [userResult] = await connection.execute(`
                INSERT INTO usuarios (nome, email, senha_hash, status, motivo_bloqueio)
                VALUES (?, ?, ?, 'bloqueado', 'ativacao_pendente')
            `, [adminName, adminEmail, placeholderHash]);
            userId = Number(userResult.insertId);
        }

        const [linkResult] = await connection.execute(`
            INSERT INTO clinica_usuarios (clinica_id, usuario_id, papel, status)
            VALUES (?, ?, 'administrador', 'convite_pendente')
        `, [clinicId, userId]);
        const invitationToken = createInvitationToken();
        const [invitationResult] = await connection.execute(`
            INSERT INTO convites_clinica (
                clinica_id, clinica_usuario_id, email_normalizado, papel,
                token_hash, expira_em, criado_por_usuario_id, criado_por_operador_id
            ) VALUES (?, ?, ?, 'administrador', ?,
                DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? HOUR), NULL, ?)
        `, [
            clinicId, linkResult.insertId, adminEmail, hashInvitationToken(invitationToken),
            invitation.ttlHours, operator.id
        ]);
        const invitationId = Number(invitationResult.insertId);
        await connection.execute(`
            INSERT INTO auditoria (clinica_id, usuario_id, acao, entidade_tipo, entidade_id, metadados)
            VALUES (?, NULL, 'clinica_provisionada', 'clinica', ?, ?)
        `, [clinicId, clinicId, JSON.stringify({ slug: clinicSlug, status: 'ativa' })]);
        await connection.execute(`
            INSERT INTO auditoria_plataforma (
                operador_plataforma_id, clinica_id, acao, entidade_tipo, entidade_id, metadados
            ) VALUES (?, ?, 'clinica_provisionada', 'clinica', ?, ?)
        `, [operator.id, clinicId, clinicId, JSON.stringify({ slug: clinicSlug })]);
        await connection.commit();
        created = { clinicId, invitationId, invitationToken };
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Já existe uma clínica com este slug.' });
        }
        if (error.code === 'ER_LOCK_DEADLOCK') {
            return res.status(409).json({ error: 'Provisionamento concorrente detectado. Atualize a lista e tente novamente.' });
        }
        logFailure('provision_failed', error);
        return res.status(500).json({ error: 'Erro ao provisionar clínica.' });
    } finally {
        connection?.release();
    }

    const delivery = await mailer.sendInvitation({
        recipient: adminEmail,
        clinicName,
        role: 'administrador',
        token: created.invitationToken
    });
    try {
        await recordDelivery(created.invitationId, created.clinicId, delivery);
    } catch (error) {
        logFailure('record_delivery_failed', error);
    }
    const presentation = deliveryPresentation(delivery);
    return res.status(201).json({
        clinica: { id: created.clinicId, nome: clinicName, slug: clinicSlug, timezone: clinicTimezone, status: 'ativa' },
        convite_id: created.invitationId,
        entrega: presentation.entrega,
        message: presentation.message
    });
};

exports.getSettings = async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT id, nome, slug, timezone, status
            FROM clinicas WHERE id = ? LIMIT 1
        `, [req.tenant.clinicId]);
        if (!rows[0]) return res.status(404).json({ error: 'Clínica não encontrada.' });
        return res.status(200).json({ ...rows[0], id: Number(rows[0].id) });
    } catch (error) {
        logFailure('settings_get_failed', error);
        return res.status(500).json({ error: 'Erro ao consultar configurações.' });
    }
};

exports.updateSettings = async (req, res) => {
    const clinicName = text(req.body?.nome, 2, 160);
    const clinicTimezone = timezone(req.body?.timezone);
    if (!clinicName || !clinicTimezone) {
        return res.status(400).json({ error: 'Nome ou fuso horário inválido.' });
    }
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [actors] = await connection.execute(`
            SELECT cu.id
            FROM clinica_usuarios cu
            JOIN usuarios u ON u.id = cu.usuario_id
            JOIN clinicas c ON c.id = cu.clinica_id
            WHERE cu.clinica_id = ? AND cu.usuario_id = ?
              AND cu.status = 'ativo'
              AND (cu.papel = 'administrador' OR (
                    cu.papel = 'profissional' AND EXISTS (
                        SELECT 1 FROM consultorios_profissionais cp
                        JOIN identidades_profissionais ip
                          ON ip.usuario_id = cp.titular_usuario_id
                         AND ip.status_verificacao = 'verificada'
                        WHERE cp.clinica_id = cu.clinica_id
                          AND cp.titular_usuario_id = cu.usuario_id
                          AND cp.status = 'ativo'
                    )
              ))
              AND cu.sessao_versao = ? AND u.status = 'ativo' AND c.status = 'ativa'
            FOR UPDATE
        `, [req.tenant.clinicId, req.userId, req.auth?.membershipVersion]);
        if (!actors[0]) {
            await connection.rollback();
            return res.status(403).json({ error: 'Responsável não autorizado ou sessão desatualizada.' });
        }
        const [result] = await connection.execute(`
            UPDATE clinicas SET nome = ?, timezone = ?
            WHERE id = ? AND status = 'ativa'
        `, [clinicName, clinicTimezone, req.tenant.clinicId]);
        if (result.affectedRows !== 1) {
            await connection.rollback();
            return res.status(409).json({ error: 'A clínica não está ativa.' });
        }
        await connection.execute(`
            INSERT INTO auditoria (clinica_id, usuario_id, acao, entidade_tipo, entidade_id, metadados)
            VALUES (?, ?, 'configuracoes_clinica_alteradas', 'clinica', ?, ?)
        `, [
            req.tenant.clinicId, req.userId, req.tenant.clinicId,
            JSON.stringify({ campos: ['nome', 'timezone'] })
        ]);
        await connection.commit();
        return res.status(200).json({
            message: 'Configurações da clínica atualizadas.',
            clinica: { id: req.tenant.clinicId, nome: clinicName, timezone: clinicTimezone }
        });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        logFailure('settings_update_failed', error);
        return res.status(500).json({ error: 'Erro ao atualizar configurações.' });
    } finally {
        connection?.release();
    }
};

exports._private = {
    deliveryPresentation, email, platformOperator, positiveId,
    reissueDeliveryPresentation, slug, text, timezone
};
