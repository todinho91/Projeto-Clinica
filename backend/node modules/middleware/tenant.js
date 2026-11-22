const pool = require('../config/database');

module.exports = async function tenantContext(req, res, next) {
    const clinicId = req.auth?.clinicId;
    const membershipVersion = req.auth?.membershipVersion;
    if (
        req.auth?.tokenType !== 'clinic'
        || !Number.isSafeInteger(clinicId)
        || clinicId <= 0
        || !Number.isSafeInteger(membershipVersion)
        || membershipVersion <= 0
    ) {
        return res.status(403).json({ error: 'Selecione uma clínica ativa para continuar.' });
    }

    try {
        const [rows] = await pool.execute(`
            SELECT cu.clinica_id, cu.papel, cu.sessao_versao, c.nome AS clinica_nome,
                   CASE WHEN cp.titular_usuario_id = cu.usuario_id AND cp.status = 'ativo'
                             AND ip.status_verificacao = 'verificada'
                        THEN 1 ELSE 0 END AS consultorio_titular
            FROM clinica_usuarios cu
            JOIN clinicas c ON c.id = cu.clinica_id
            JOIN usuarios u ON u.id = cu.usuario_id
            LEFT JOIN consultorios_profissionais cp ON cp.clinica_id = cu.clinica_id
            LEFT JOIN identidades_profissionais ip ON ip.usuario_id = cp.titular_usuario_id
            WHERE cu.clinica_id = ?
              AND cu.usuario_id = ?
              AND cu.status = 'ativo'
              AND c.status = 'ativa'
              AND u.status = 'ativo'
              AND cu.sessao_versao = ?
            LIMIT 1
        `, [clinicId, req.userId, membershipVersion]);

        if (rows.length === 0) {
            return res.status(403).json({ error: 'Vínculo com a clínica inexistente ou inativo.' });
        }

        req.tenant = {
            clinicId: Number(rows[0].clinica_id),
            clinicName: rows[0].clinica_nome,
            role: rows[0].papel
        };
        if (rows[0].consultorio_titular) req.tenant.isPracticeOwner = true;
        return next();
    } catch (error) {
        console.error('Erro ao validar clínica ativa:', error);
        return res.status(500).json({ error: 'Erro ao validar a clínica ativa.' });
    }
};
