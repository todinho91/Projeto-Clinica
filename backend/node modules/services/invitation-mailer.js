const { invitation } = require('../config/environment');

async function sendInvitation({ recipient, clinicName, role, token }) {
    if (invitation.mailProvider !== 'webhook') {
        return { status: 'not_configured', delivered: false, reason: 'provider_not_configured' };
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
        if (!response.ok) {
            return { status: 'failed', delivered: false, reason: 'provider_rejected' };
        }
        const rawMessageId = response.headers?.get?.('x-message-id');
        return {
            status: 'accepted_by_provider',
            delivered: false,
            providerMessageId: typeof rawMessageId === 'string' ? rawMessageId.slice(0, 200) : null
        };
    } catch {
        return { status: 'failed', delivered: false, reason: 'provider_unavailable' };
    }
}

module.exports = { sendInvitation };
