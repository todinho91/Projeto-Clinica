const FIELDS = Object.freeze([
    'queixa', 'anamnese', 'antecedentes', 'alergias', 'medicamentos',
    'avaliacao', 'evolucao', 'diagnostico', 'conduta'
]);
const MAX_FIELD = 8000;
const MAX_TOTAL = 32000;

function positiveId(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    if (!/^[1-9]\d*$/.test(String(value))) return null;
    const id = Number(value);
    return Number.isSafeInteger(id) ? id : null;
}

function plainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function onlyKeys(value, keys) {
    return plainObject(value) && Object.keys(value).every(key => keys.includes(key));
}

function clinicalText(value, max = MAX_FIELD) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return undefined;
    return value.trim() || null;
}

function recordContent(value) {
    if (!onlyKeys(value, FIELDS)) return null;
    const content = Object.fromEntries(FIELDS.map(key => [key, clinicalText(value[key])]));
    if (Object.values(content).includes(undefined)
        || Buffer.byteLength(JSON.stringify(content), 'utf8') > MAX_TOTAL) return null;
    return content;
}

function addendumContent(value) {
    if (!onlyKeys(value, ['texto', 'motivo'])) return null;
    const texto = clinicalText(value.texto);
    const motivo = clinicalText(value.motivo, 1000);
    return texto && motivo ? { texto, motivo } : null;
}

function eligible(status, started) {
    return status === 'realizada' || (Boolean(started) && ['agendada', 'confirmada'].includes(status));
}

function canRead(state, status, started) {
    // Finalized evidence survives anomalies in the appointment lifecycle.
    return state === 'finalizado' || eligible(status, started);
}

function nextState(state, action) {
    if (state === 'rascunho') {
        if (action === 'rascunho') return 'rascunho';
        if (action === 'finalizacao') return 'finalizado';
        if (action === 'descarte') return 'descartado';
    }
    if (state === 'finalizado' && action === 'adendo') return 'finalizado';
    return null;
}

function completeForFinalization(content, author) {
    return Boolean(content?.evolucao && content?.conduta
        && author?.conselho_tipo && author?.conselho_numero);
}

module.exports = { FIELDS, positiveId, onlyKeys, recordContent, addendumContent,
    eligible, canRead, nextState, completeForFinalization };
