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
        const [result] = await connection.execute(`
            INSERT INTO especialidades (clinica_id, nome, status)
            VALUES (?, ?, 'ativa')
        `, [clinicId, payload.name]);
        const specialtyId = Number(result.insertId);
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

exports.specialtyPayload = specialtyPayload;
