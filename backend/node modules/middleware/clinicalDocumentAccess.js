module.exports = function clinicalDocumentAccess(req, res, next) {
    if (!req.tenant) {
        return res.status(403).json({ error: 'Permissão insuficiente para esta operação.' });
    }
    if (req.tenant.isPractice && req.tenant.isPracticeOwner !== true) {
        return res.status(403).json({
            error: 'Documentos clínicos são restritos ao profissional titular do consultório.'
        });
    }
    return next();
};
