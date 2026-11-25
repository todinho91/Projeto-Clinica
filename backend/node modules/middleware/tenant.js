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
                   cp.clinica_id AS consultorio_id,
                   cp.titular_usuario_id AS consultorio_titular_usuario_id,
                   ip.status_verificacao AS identidade_profissional_status,
                   CASE WHEN cp.titular_usuario_id = cu.usuario_id AND cp.status = 'ativo'
                             AND ip.status_verificacao = 'verificada'
                        THEN 1 ELSE 0 END AS consultorio_titular,
                   COALESCE(cd.gerenciar_disponibilidade, 0) AS gerenciar_disponibilidade
            FROM clinica_usuarios cu
            JOIN clinicas c ON c.id = cu.clinica_id
            JOIN usuarios u ON u.id = cu.usuario_id
            LEFT JOIN consultorios_profissionais cp ON cp.clinica_id = cu.clinica_id
            LEFT JOIN identidades_profissionais ip ON ip.usuario_id = cp.titular_usuario_id
            LEFT JOIN consultorio_delegacoes cd
              ON cd.clinica_id = cu.clinica_id AND cd.clinica_usuario_id = cu.id
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
        if (rows[0].consultorio_titular_usuario_id != null
            && Number(rows[0].consultorio_titular_usuario_id) === req.userId
            && rows[0].identidade_profissional_status !== 'verificada') {
            return res.status(403).json({
                error: 'A verificação profissional do titular não está ativa.'
            });
        }

        req.tenant = {
            clinicId: Number(rows[0].clinica_id),
            clinicName: rows[0].clinica_nome,
            role: rows[0].papel
        };
        if (rows[0].consultorio_id != null) req.tenant.isPractice = true;
        if (rows[0].consultorio_titular) req.tenant.isPracticeOwner = true;
        req.tenant.permissions = {
            manageAvailability: Boolean(rows[0].gerenciar_disponibilidade)
        };
        return next();
    } catch (error) {
        console.error('Erro ao validar clínica ativa:', error);
        return res.status(500).json({ error: 'Erro ao validar a clínica ativa.' });
    }
};
