module.exports = function practiceTeamManager(req, res, next) {
    if (!req.tenant) {
        return res.status(403).json({ error: 'Permissão insuficiente para esta operação.' });
    }
    if (req.tenant.isPractice) {
        if (req.tenant.role !== 'profissional' || req.tenant.isPracticeOwner !== true) {
            return res.status(403).json({
                error: 'Somente o titular pode gerenciar acessos deste consultório.'
            });
        }
        req.workspaceOwner = true;
        return next();
    }
    if (!['administrador', 'secretaria'].includes(req.tenant.role)) {
        return res.status(403).json({ error: 'Permissão insuficiente para esta operação.' });
    }
    return next();
};
