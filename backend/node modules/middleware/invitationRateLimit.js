const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 30;

module.exports = (req, res, next) => {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    if (attempts.size > 10_000) {
        for (const [candidate, entry] of attempts) {
            if (entry.resetAt <= now) attempts.delete(candidate);
        }
    }
    const current = attempts.get(key);
    if (!current || current.resetAt <= now) {
        attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
        return next();
    }
    current.count += 1;
    if (current.count > LIMIT) {
        res.set('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)));
        return res.status(429).json({ error: 'Muitas tentativas. Tente novamente mais tarde.' });
    }
    return next();
};
