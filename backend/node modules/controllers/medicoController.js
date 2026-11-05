const pool = require('../config/database');

function positiveId(value) {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function optionalText(value, max) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max) return undefined;
    return value.trim();
}

function professionalPayload(body = {}) {
    const name = typeof body.nome_exibicao === 'string' ? body.nome_exibicao.trim() : '';
    const councilType = optionalText(body.conselho_tipo, 30);
    const councilNumber = optionalText(body.conselho_numero, 40);
    const rawSpecialties = body.especialidade_ids ?? [];
    if (
        name.length < 2 || name.length > 160
        || councilType === undefined || councilNumber === undefined
        || Boolean(councilType) !== Boolean(councilNumber)
        || !Array.isArray(rawSpecialties) || rawSpecialties.length > 50
    ) return null;

    const specialtyIds = [...new Set(rawSpecialties.map(positiveId))];
    if (specialtyIds.some((id) => id === null)) return null;
    return {
        name,
        councilType: councilType?.toUpperCase() ?? null,
        councilNumber,
        specialtyIds
    };
}

async function validateSpecialties(connection, clinicId, specialtyIds) {
    if (specialtyIds.length === 0) return true;
    const placeholders = specialtyIds.map(() => '?').join(', ');
    const [rows] = await connection.execute(`
        SELECT id
        FROM especialidades
        WHERE clinica_id = ? AND status = 'ativa' AND id IN (${placeholders})
        FOR UPDATE
    `, [clinicId, ...specialtyIds]);
    return rows.length === specialtyIds.length;
}

async function replaceSpecialties(connection, clinicId, professionalId, specialtyIds) {
    await connection.execute(`
        DELETE FROM profissional_especialidades
        WHERE clinica_id = ? AND profissional_id = ?
    `, [clinicId, professionalId]);
    if (specialtyIds.length === 0) return;
    const values = specialtyIds.map(() => '(?, ?, ?)').join(', ');
    const params = specialtyIds.flatMap((specialtyId) => [clinicId, professionalId, specialtyId]);
    await connection.execute(`
        INSERT INTO profissional_especialidades (clinica_id, profissional_id, especialidade_id)
        VALUES ${values}
    `, params);
}

async function audit(connection, req, action, professionalId, metadata = {}) {
    await connection.execute(`
        INSERT INTO auditoria (
            clinica_id, usuario_id, acao, entidade_tipo, entidade_id, metadados
        ) VALUES (?, ?, ?, 'profissional', ?, ?)
    `, [req.tenant.clinicId, req.userId, action, professionalId, JSON.stringify(metadata)]);
}

exports.getAllMedicos = async (req, res) => {
    try {
        const [profissionais] = await pool.execute(`
            SELECT
                p.id,
                p.nome_exibicao AS nome,
                p.conselho_tipo,
                p.conselho_numero,
                GROUP_CONCAT(e.nome ORDER BY e.nome SEPARATOR ', ') AS especialidades
            FROM profissionais p
            JOIN clinica_usuarios cu
              ON cu.clinica_id = p.clinica_id
             AND cu.usuario_id = p.usuario_id
             AND cu.papel = 'profissional'
             AND cu.status = 'ativo'
            JOIN usuarios u
              ON u.id = p.usuario_id
             AND u.status = 'ativo'
            LEFT JOIN profissional_especialidades pe
              ON pe.clinica_id = p.clinica_id
             AND pe.profissional_id = p.id
            LEFT JOIN especialidades e
              ON e.clinica_id = pe.clinica_id
             AND e.id = pe.especialidade_id
             AND e.status = 'ativa'
            WHERE p.clinica_id = ? AND p.status = 'ativo'
            GROUP BY p.id, p.nome_exibicao, p.conselho_tipo, p.conselho_numero
            ORDER BY p.nome_exibicao
        `, [req.tenant.clinicId]);
        return res.status(200).json(profissionais);
    } catch (error) {
        console.error('Erro ao buscar profissionais:', error);
        return res.status(500).json({ error: 'Erro ao buscar profissionais.' });
    }
};

exports.listForManagement = async (req, res) => {
    const clinicId = req.tenant.clinicId;
    try {
        const [[professionals], [specialties]] = await Promise.all([
            pool.execute(`
                SELECT
                    p.id, p.usuario_id, p.nome_exibicao AS nome,
                    p.conselho_tipo, p.conselho_numero, p.status,
                    u.email
                FROM profissionais p
                JOIN usuarios u ON u.id = p.usuario_id
                WHERE p.clinica_id = ?
                ORDER BY p.nome_exibicao
            `, [clinicId]),
            pool.execute(`
                SELECT pe.profissional_id, e.id, e.nome
                FROM profissional_especialidades pe
                JOIN especialidades e
                  ON e.clinica_id = pe.clinica_id
                 AND e.id = pe.especialidade_id
                WHERE pe.clinica_id = ?
                ORDER BY e.nome
            `, [clinicId])
        ]);
        const byProfessional = new Map();
        specialties.forEach((item) => {
            const key = Number(item.profissional_id);
            if (!byProfessional.has(key)) byProfessional.set(key, []);
            byProfessional.get(key).push({ id: Number(item.id), nome: item.nome });
        });
        return res.status(200).json(professionals.map((professional) => ({
            ...professional,
            id: Number(professional.id),
            usuario_id: Number(professional.usuario_id),
            especialidades: byProfessional.get(Number(professional.id)) ?? []
        })));
    } catch (error) {
        console.error('Erro ao listar profissionais para gestão:', error);
        return res.status(500).json({ error: 'Erro ao listar profissionais.' });
    }
};

exports.getManagementOptions = async (req, res) => {
    const clinicId = req.tenant.clinicId;
    try {
        const [[users], [specialties]] = await Promise.all([
            pool.execute(`
                SELECT u.id, u.nome, u.email
                FROM clinica_usuarios cu
                JOIN usuarios u ON u.id = cu.usuario_id AND u.status = 'ativo'
                LEFT JOIN profissionais p
                  ON p.clinica_id = cu.clinica_id
                 AND p.usuario_id = cu.usuario_id
                WHERE cu.clinica_id = ?
                  AND cu.papel = 'profissional'
                  AND cu.status = 'ativo'
                  AND p.id IS NULL
                ORDER BY u.nome
            `, [clinicId]),
            pool.execute(`
                SELECT id, nome
                FROM especialidades
                WHERE clinica_id = ? AND status = 'ativa'
                ORDER BY nome
            `, [clinicId])
        ]);
        return res.status(200).json({
            usuarios: users.map((user) => ({ ...user, id: Number(user.id) })),
            especialidades: specialties.map((specialty) => ({ ...specialty, id: Number(specialty.id) }))
        });
    } catch (error) {
        console.error('Erro ao carregar opções de profissionais:', error);
        return res.status(500).json({ error: 'Erro ao carregar opções para cadastro.' });
    }
};

exports.createProfessional = async (req, res) => {
    const userId = positiveId(req.body?.usuario_id);
    const payload = professionalPayload(req.body);
    if (!userId || !payload) {
        return res.status(400).json({ error: 'Dados do profissional inválidos.' });
    }

    const clinicId = req.tenant.clinicId;
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [links] = await connection.execute(`
            SELECT cu.usuario_id
            FROM clinica_usuarios cu
            JOIN usuarios u ON u.id = cu.usuario_id
            LEFT JOIN profissionais p
              ON p.clinica_id = cu.clinica_id
             AND p.usuario_id = cu.usuario_id
            WHERE cu.clinica_id = ?
              AND cu.usuario_id = ?
              AND cu.papel = 'profissional'
              AND cu.status = 'ativo'
              AND u.status = 'ativo'
              AND p.id IS NULL
            FOR UPDATE
        `, [clinicId, userId]);
        if (links.length === 0) {
            await connection.rollback();
            return res.status(409).json({ error: 'Usuário sem vínculo profissional disponível na clínica ativa.' });
        }
        if (!(await validateSpecialties(connection, clinicId, payload.specialtyIds))) {
            await connection.rollback();
            return res.status(400).json({ error: 'Especialidade inválida para a clínica ativa.' });
        }

        const [result] = await connection.execute(`
            INSERT INTO profissionais (
                clinica_id, usuario_id, nome_exibicao,
                conselho_tipo, conselho_numero, status
            ) VALUES (?, ?, ?, ?, ?, 'ativo')
        `, [clinicId, userId, payload.name, payload.councilType, payload.councilNumber]);
        const professionalId = Number(result.insertId);
        await replaceSpecialties(connection, clinicId, professionalId, payload.specialtyIds);
        await audit(connection, req, 'profissional_criado', professionalId, { status: 'ativo' });
        await connection.commit();
        return res.status(201).json({ id: professionalId, message: 'Profissional cadastrado com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Profissional ou registro de conselho já cadastrado nesta clínica.' });
        }
        console.error('Erro ao cadastrar profissional:', error);
        return res.status(500).json({ error: 'Erro ao cadastrar profissional.' });
    } finally {
        connection?.release();
    }
};

exports.updateProfessional = async (req, res) => {
    const professionalId = positiveId(req.params.id);
    const payload = professionalPayload(req.body);
    if (!professionalId || !payload) {
        return res.status(400).json({ error: 'Dados do profissional inválidos.' });
    }

    const clinicId = req.tenant.clinicId;
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [rows] = await connection.execute(`
            SELECT id FROM profissionais
            WHERE clinica_id = ? AND id = ?
            FOR UPDATE
        `, [clinicId, professionalId]);
        if (rows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Profissional não encontrado na clínica ativa.' });
        }
        if (!(await validateSpecialties(connection, clinicId, payload.specialtyIds))) {
            await connection.rollback();
            return res.status(400).json({ error: 'Especialidade inválida para a clínica ativa.' });
        }

        await connection.execute(`
            UPDATE profissionais
            SET nome_exibicao = ?, conselho_tipo = ?, conselho_numero = ?
            WHERE clinica_id = ? AND id = ?
        `, [payload.name, payload.councilType, payload.councilNumber, clinicId, professionalId]);
        await replaceSpecialties(connection, clinicId, professionalId, payload.specialtyIds);
        await audit(connection, req, 'profissional_atualizado', professionalId);
        await connection.commit();
        return res.status(200).json({ message: 'Profissional atualizado com sucesso.' });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'Registro de conselho já cadastrado nesta clínica.' });
        }
        console.error('Erro ao atualizar profissional:', error);
        return res.status(500).json({ error: 'Erro ao atualizar profissional.' });
    } finally {
        connection?.release();
    }
};

exports.updateProfessionalStatus = async (req, res) => {
    const professionalId = positiveId(req.params.id);
    const status = req.body?.status;
    if (!professionalId || !['ativo', 'inativo'].includes(status)) {
        return res.status(400).json({ error: 'Profissional ou status inválido.' });
    }

    const clinicId = req.tenant.clinicId;
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [rows] = await connection.execute(`
            SELECT p.id, cu.papel, cu.status AS vinculo_status, u.status AS usuario_status
            FROM profissionais p
            LEFT JOIN clinica_usuarios cu
              ON cu.clinica_id = p.clinica_id
             AND cu.usuario_id = p.usuario_id
            LEFT JOIN usuarios u ON u.id = p.usuario_id
            WHERE p.clinica_id = ? AND p.id = ?
            FOR UPDATE
        `, [clinicId, professionalId]);
        if (rows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Profissional não encontrado na clínica ativa.' });
        }
        if (
            status === 'ativo'
            && (rows[0].papel !== 'profissional' || rows[0].vinculo_status !== 'ativo' || rows[0].usuario_status !== 'ativo')
        ) {
            await connection.rollback();
            return res.status(409).json({ error: 'O vínculo profissional precisa estar ativo antes da reativação.' });
        }

        await connection.execute(`
            UPDATE profissionais SET status = ?
            WHERE clinica_id = ? AND id = ?
        `, [status, clinicId, professionalId]);
        await audit(connection, req, 'profissional_status_alterado', professionalId, { status });
        await connection.commit();
        return res.status(200).json({ message: `Profissional ${status === 'ativo' ? 'ativado' : 'desativado'} com sucesso.` });
    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        console.error('Erro ao alterar status do profissional:', error);
        return res.status(500).json({ error: 'Erro ao alterar status do profissional.' });
    } finally {
        connection?.release();
    }
};
