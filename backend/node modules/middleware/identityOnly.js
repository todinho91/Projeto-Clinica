module.exports = function identityOnly(req, res, next) {
    if (req.auth?.tokenType !== 'identity') {
        return res.status(403).json({
            error: 'Use um token de identidade para gerenciar ou selecionar clínicas.'
        });
    }
    return next();
};
