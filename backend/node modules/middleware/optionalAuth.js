const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/environment');

module.exports = (req, res, next) => {
    const header = req.headers.authorization;
    if (!header) return next();
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return res.status(401).json({ error: 'Token mal formatado.' });
    try {
        const decoded = jwt.verify(match[1], jwtSecret, { algorithms: ['HS256'] });
        const userId = Number(decoded.sub);
        if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('invalid subject');
        req.userId = userId;
        req.auth = { tokenType: decoded.token_type, clinicId: decoded.clinic_id ?? null };
        return next();
    } catch {
        return res.status(401).json({ error: 'Token inválido.' });
    }
};
