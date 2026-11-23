module.exports = function institutionalOnly(...roles) {
    const allowed = new Set(roles);
    return (req, res, next) => {
        if (!req.tenant || req.tenant.isPractice || !allowed.has(req.tenant.role)) {
            return res.status(403).json({
                error: 'Operação disponível somente para a administração de clínicas institucionais.'
            });
        }
        return next();
    };
};
