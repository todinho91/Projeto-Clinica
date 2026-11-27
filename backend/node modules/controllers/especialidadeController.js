const pool = require('../config/database');

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function specialtyPayload(body = {}) {
    if (typeof body.nome !== 'string') return null;
    const name = body.nome.trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 120) return null;
    return { name };
}

async function audit(connection, req, action, specialtyId, metadata = {}) {
    await connection.execute(`
        INSERT INTO auditoria (
            clinica_id, usuario_id, acao, entidade_tipo, entidade_id, metadados
        ) VALUES (?, ?, ?, 'especialidade', ?, ?)
    `, [req.tenant.clinicId, req.userId, action, specialtyId, JSON.stringify(metadata)]);
}

async function lockAuthorizedManager(connection, req) {
    const [rows] = await connection.execute(`
        SELECT cu.papel, cp.clinica_id AS consultorio_id,
               p.id AS titular_profissional_id,
               CASE WHEN cp.titular_usuario_id = cu.usuario_id
                          AND cp.status = 'ativo'
                          AND ip.status_verificacao = 'verificada'
                    THEN 1 ELSE 0 END AS consultorio_titular
        FROM clinica_usuarios cu
        JOIN usuarios u ON u.id = cu.usuario_id AND u.status = 'ativo'
        JOIN clinicas c ON c.id = cu.clinica_id AND c.status = 'ativa'
        LEFT JOIN consultorios_profissionais cp ON cp.clinica_id = cu.clinica_id
        LEFT JOIN identidades_profissionais ip ON ip.usuario_id = cp.titular_usuario_id
        LEFT JOIN profissionais p ON p.clinica_id = cp.clinica_id
          AND p.usuario_id = cp.titular_usuario_id AND p.status = 'ativo'
        WHERE cu.clinica_id = ? AND cu.usuario_id = ? AND cu.papel = ?
          AND cu.status = 'ativo' AND cu.sessao_versao = ?
        FOR UPDATE
    `, [req.tenant.clinicId, req.userId, req.tenant.role, req.auth?.membershipVersion]);
    const actor = rows[0];
    if (!actor) return null;
    const isPractice = actor.consultorio_id != null;
    if (isPractice && (!actor.consultorio_titular || actor.papel !== 'profissional'
        || !actor.titular_profissional_id)) return null;
    if (!isPractice && !['administrador', 'secretaria'].includes(actor.papel)) return null;
    return {
        isPractice,
        professionalId: actor.titular_profissional_id
            ? Number(actor.titular_profissional_id) : null
    };
}

exports.listForManagement = async (req, res) => {
    try {
        const [specialties] = await pool.execute(`
            SELECT
                e.id, e.nome, e.status,
                COUNT(DISTINCT pe.profissional_id) AS total_profissionais,
                COUNT(DISTINCT CASE WHEN p.status = 'ativo' THEN p.id END) AS profissionais_ativos
            FROM especialidades e
            LEFT JOIN profissional_especialidades pe
              ON pe.clinica_id = e.clinica_id
             AND pe.especialidade_id = e.id
            LEFT JOIN profissionais p
              ON p.clinica_id = pe.clinica_id
             AND p.id = pe.profissional_id
            WHERE e.clinica_id = ?
            GROUP BY e.id, e.nome, e.status
            ORDER BY e.nome
        `, [req.tenant.clinicId]);
        return res.status(200).json(specialties.map((specialty) => ({
            ...specialty,
            id: Number(specialty.id),
            total_profissionais: Number(specialty.total_profissionais),
            profissionais_ativos: Number(specialty.profissionais_ativos)
        })));
    } catch (error) {
        console.error('Erro ao listar especialidades para gestão:', error);
        return res.status(500).json({ error: 'Erro ao listar especialidades.' });
    }
};

exports.createSpecialty = async (req, res) => {
    const payload = specialtyPayload(req.body);
    if (!payload) return res.status(400).json({ error: 'Nome da especialidade inválido.' });

    const clinicId = req.tenant.clinicId;
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const actor = await lockAuthorizedManager(connection, req);
        if (!actor) {
            await connection.rollback();
            return res.status(403).json({ error: 'Responsável não autorizado ou sessão desatualizada.' });
        }
        const [result] = await connection.execute(`
            INSERT INTO especialidades (clinica_id, nome, status)
            VALUES (?, ?, 'ativa')
        `, [clinicId, payload.name]);
        const specialtyId = Number(result.insertId);
        if (actor.isPractice) {
            await connection.execute(`
                INSERT INTO profissional_especialidades (
                    clinica_id, profissional_id, especialidade_id
                ) VALUES (?, ?, ?)
            `, [clinicId, actor.professionalId, specialtyId]);
        }
        await audit(connection, req, 'especialidade_criada', specialtyId, { status: 'ativa' });
        await connection.commit();
        return res.status(201).json({ id: specialtyId, message: 'Especialidade cadastrada com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Já existe uma especialidade com este nome na clínica ativa.' });
        }
        console.error('Erro ao cadastrar especialidade:', error);
        return res.status(500).json({ error: 'Erro ao cadastrar especialidade.' });
    } finally {
        connection?.release();
    }
};

exports.updateSpecialty = async (req, res) => {
    const specialtyId = positiveId(req.params.id);
    const payload = specialtyPayload(req.body);
    if (!specialtyId || !payload) {
        return res.status(400).json({ error: 'Especialidade ou nome inválido.' });
    }

    const clinicId = req.tenant.clinicId;
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        if (!await lockAuthorizedManager(connection, req)) {
            await connection.rollback();
            return res.status(403).json({ error: 'Responsável não autorizado ou sessão desatualizada.' });
        }
        const [rows] = await connection.execute(`
            SELECT id, nome FROM especialidades
            WHERE clinica_id = ? AND id = ?
            FOR UPDATE
        `, [clinicId, specialtyId]);
        if (rows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Especialidade não encontrada na clínica ativa.' });
        }
        await connection.execute(`
            UPDATE especialidades SET nome = ?
            WHERE clinica_id = ? AND id = ?
        `, [payload.name, clinicId, specialtyId]);
        await audit(connection, req, 'especialidade_atualizada', specialtyId, {
            nome_anterior: rows[0].nome,
            nome_atual: payload.name
        });
        await connection.commit();
        return res.status(200).json({ message: 'Especialidade atualizada com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Já existe uma especialidade com este nome na clínica ativa.' });
        }
        console.error('Erro ao atualizar especialidade:', error);
        return res.status(500).json({ error: 'Erro ao atualizar especialidade.' });
    } finally {
        connection?.release();
    }
};

exports.updateSpecialtyStatus = async (req, res) => {
    const specialtyId = positiveId(req.params.id);
    const status = req.body?.status;
    if (!specialtyId || !['ativa', 'inativa'].includes(status)) {
        return res.status(400).json({ error: 'Especialidade ou status inválido.' });
    }

    const clinicId = req.tenant.clinicId;
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        if (!await lockAuthorizedManager(connection, req)) {
            await connection.rollback();
            return res.status(403).json({ error: 'Responsável não autorizado ou sessão desatualizada.' });
        }
        const [rows] = await connection.execute(`
            SELECT id, status FROM especialidades
            WHERE clinica_id = ? AND id = ?
            FOR UPDATE
        `, [clinicId, specialtyId]);
        if (rows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Especialidade não encontrada na clínica ativa.' });
        }
        await connection.execute(`
            UPDATE especialidades SET status = ?
            WHERE clinica_id = ? AND id = ?
        `, [status, clinicId, specialtyId]);
        await audit(connection, req, 'especialidade_status_alterado', specialtyId, { status });
        await connection.commit();
        return res.status(200).json({
            message: `Especialidade ${status === 'ativa' ? 'ativada' : 'desativada'} com sucesso.`
        });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        console.error('Erro ao alterar status da especialidade:', error);
        return res.status(500).json({ error: 'Erro ao alterar status da especialidade.' });
    } finally {
        connection?.release();
    }
};

exports.deleteSpecialty = async (req, res) => {
    const specialtyId = positiveId(req.params.id);
    if (!specialtyId) return res.status(400).json({ error: 'Especialidade inválida.' });
    const clinicId = req.tenant.clinicId;
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const actor = await lockAuthorizedManager(connection, req);
        if (!actor) {
            await connection.rollback();
            return res.status(403).json({ error: 'Responsável não autorizado ou sessão desatualizada.' });
        }
        const [specialties] = await connection.execute(`
            SELECT id, nome FROM especialidades
            WHERE clinica_id = ? AND id = ? FOR UPDATE
        `, [clinicId, specialtyId]);
        if (!specialties.length) {
            await connection.rollback();
            return res.status(404).json({ error: 'Especialidade não encontrada na clínica ativa.' });
        }
        const [appointments] = await connection.execute(`
            SELECT id FROM consultas
            WHERE clinica_id = ? AND especialidade_id = ? LIMIT 1 FOR UPDATE
        `, [clinicId, specialtyId]);
        if (appointments.length) {
            await connection.rollback();
            return res.status(409).json({ error: 'Não é possível excluir: existem consultas vinculadas. Desative a especialidade para preservar o histórico.' });
        }
        const [associations] = await connection.execute(`
            SELECT profissional_id FROM profissional_especialidades
            WHERE clinica_id = ? AND especialidade_id = ? FOR UPDATE
        `, [clinicId, specialtyId]);
        const onlyAutomaticOwnerAssociation = actor.isPractice && associations.length === 1
            && Number(associations[0].profissional_id) === actor.professionalId;
        if (associations.length && !onlyAutomaticOwnerAssociation) {
            await connection.rollback();
            return res.status(409).json({ error: 'Não é possível excluir: existem profissionais vinculados. Remova os vínculos operacionais ou desative a especialidade.' });
        }
        if (onlyAutomaticOwnerAssociation) {
            await connection.execute(`
                DELETE FROM profissional_especialidades
                WHERE clinica_id = ? AND profissional_id = ? AND especialidade_id = ?
            `, [clinicId, actor.professionalId, specialtyId]);
        }
        const [deleted] = await connection.execute(`
            DELETE FROM especialidades WHERE clinica_id = ? AND id = ?
        `, [clinicId, specialtyId]);
        if (deleted.affectedRows !== 1) {
            await connection.rollback();
            return res.status(409).json({ error: 'A especialidade mudou durante a operação. Atualize a lista e tente novamente.' });
        }
        await audit(connection, req, 'especialidade_excluida', specialtyId, {
            nome: specialties[0].nome,
            associacao_titular_removida: onlyAutomaticOwnerAssociation
        });
        await connection.commit();
        return res.status(200).json({ message: 'Especialidade excluída com segurança.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_ROW_IS_REFERENCED_2' || error.code === 'ER_NO_REFERENCED_ROW_2') {
            return res.status(409).json({ error: 'Há registros vinculados à especialidade. O histórico foi preservado.' });
        }
        console.error('Erro ao excluir especialidade:', error);
        return res.status(500).json({ error: 'Erro ao excluir especialidade.' });
    } finally {
        connection?.release();
    }
};

exports.specialtyPayload = specialtyPayload;
exports.lockAuthorizedManager = lockAuthorizedManager;
