const { createHash, randomBytes } = require('node:crypto');

function createInvitationToken() {
    return randomBytes(32).toString('base64url');
}

function hashInvitationToken(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 200) return null;
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

module.exports = { createInvitationToken, hashInvitationToken };
