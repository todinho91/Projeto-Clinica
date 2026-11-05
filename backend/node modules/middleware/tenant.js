const pool = require('../config/database');

module.exports = async function tenantContext(req, res, next) {
    const clinicId = req.auth?.clinicId;
    if (
        req.auth?.tokenType !== 'clinic'
        || !Number.isSafeInteger(clinicId)
        || clinicId <= 0
    ) {
        return res.status(403).json({ error: 'Selecione uma clínica ativa para continuar.' });
    }

    try {
        const [rows] = await pool.execute(`
            SELECT cu.clinica_id, cu.papel, c.nome AS clinica_nome
            FROM clinica_usuarios cu
            JOIN clinicas c ON c.id = cu.clinica_id
            JOIN usuarios u ON u.id = cu.usuario_id
            WHERE cu.clinica_id = ?
              AND cu.usuario_id = ?
              AND cu.status = 'ativo'
              AND c.status = 'ativa'
              AND u.status = 'ativo'
            LIMIT 1
        `, [clinicId, req.userId]);

        if (rows.length === 0) {
            return res.status(403).json({ error: 'Vínculo com a clínica inexistente ou inativo.' });
        }

        req.tenant = {
            clinicId: Number(rows[0].clinica_id),
            clinicName: rows[0].clinica_nome,
            role: rows[0].papel
        };
        return next();
    } catch (error) {
        console.error('Erro ao validar clínica ativa:', error);
        return res.status(500).json({ error: 'Erro ao validar a clínica ativa.' });
    }
};
