const { invitation } = require('../config/environment');

async function sendInvitation({ recipient, clinicName, role, token }) {
    if (invitation.mailProvider !== 'webhook') {
        return { delivered: false, reason: 'provider_not_configured' };
    }

    const activationUrl = new URL('/aceitar-convite.html', invitation.publicOrigin);
    activationUrl.searchParams.set('token', token);
    try {
        const response = await fetch(invitation.mailApiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${invitation.mailApiToken}`
            },
            body: JSON.stringify({
                from: invitation.mailFrom,
                to: recipient,
                template: 'vitalis-team-invitation',
                variables: { clinicName, role, activationUrl: activationUrl.toString() }
            }),
            signal: AbortSignal.timeout(8000)
        });
        return response.ok
            ? { delivered: true }
            : { delivered: false, reason: 'provider_rejected' };
    } catch {
        return { delivered: false, reason: 'provider_unavailable' };
    }
}

module.exports = { sendInvitation };
