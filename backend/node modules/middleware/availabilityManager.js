module.exports = function availabilityManager(req, res, next) {
    if (!req.tenant) {
        return res.status(403).json({ error: 'Permissão insuficiente para esta operação.' });
    }
    if (!req.tenant.isPractice) return next();
    if (req.tenant.isPracticeOwner === true) return next();
    if (req.tenant.role === 'secretaria'
        && req.tenant.permissions?.manageAvailability === true) return next();
    return res.status(403).json({
        error: 'A alteração da disponibilidade exige autorização do titular do consultório.'
    });
};
