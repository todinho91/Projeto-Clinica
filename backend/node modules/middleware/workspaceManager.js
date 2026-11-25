module.exports = function workspaceManager(...institutionalRoles) {
    const allowed = new Set(institutionalRoles);
    return (req, res, next) => {
        if (!req.tenant) {
            return res.status(403).json({ error: 'Permissão insuficiente para esta operação.' });
        }
        if (allowed.has(req.tenant.role)) return next();
        if (req.tenant.role !== 'profissional' || req.tenant.isPracticeOwner !== true) {
            return res.status(403).json({ error: 'Permissão insuficiente para esta operação.' });
        }
        req.workspaceOwner = true;
        return next();
    };
};
