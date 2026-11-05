module.exports = function authorize(...allowedRoles) {
    const allowed = new Set(allowedRoles);
    return (req, res, next) => {
        if (!req.tenant || !allowed.has(req.tenant.role)) {
            return res.status(403).json({ error: 'Permissão insuficiente para esta operação.' });
        }
        return next();
    };
};
