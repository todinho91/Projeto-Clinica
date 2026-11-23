const UF = /^[A-Z]{2}$/;

function normalizedText(value, min, max) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/\s+/g, ' ');
    return normalized.length >= min && normalized.length <= max ? normalized : null;
}

function professionalIdentity(body = {}) {
    const professionalType = normalizedText(body.tipo_profissional, 2, 80);
    const councilType = normalizedText(body.conselho_tipo, 2, 30)?.toUpperCase();
    const councilNumber = normalizedText(body.conselho_numero, 2, 40)?.toUpperCase();
    const councilState = normalizedText(body.conselho_uf, 2, 2)?.toUpperCase();
    return professionalType && councilType && councilNumber && UF.test(councilState)
        ? { professionalType, councilType, councilNumber, councilState } : null;
}

module.exports = { professionalIdentity };
