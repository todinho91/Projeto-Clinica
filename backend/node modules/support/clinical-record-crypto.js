const { createCipheriv, createDecipheriv, randomBytes, randomUUID } = require('node:crypto');

const TEST_SCHEMA = 'vitalis_prontuarios_ci_test';
const MAX_BYTES = 65536;

function syntheticEnabled(env = process.env) {
    return env.VITALIS_CLINICAL_RECORDS_ENABLED === '1' &&
        env.NODE_ENV === 'test' &&
        env.CLINICAL_RECORD_INTEGRATION_TEST === '1' &&
        env.DB_DATABASE === TEST_SCHEMA &&
        ['127.0.0.1', 'localhost'].includes(env.DB_HOST);
}
let fixtureAuthorized = false;
function fixtureEnabled() { return fixtureAuthorized && syntheticEnabled(); }
function enableSyntheticFixture() {
    if (!process.env.NODE_TEST_CONTEXT || !syntheticEnabled()) fail();
    fixtureAuthorized = true;
}
function fail() { throw new Error('RECORD_CRYPTO_FAILURE'); }
class CryptoWriteError extends Error {
    constructor(code) { super(code); this.code = code; }
}
function keyValid(key) { return Buffer.isBuffer(key) && key.length === 32; }
function canonicalId(value) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) fail();
    if (!['number', 'string', 'bigint'].includes(typeof value) ||
        !/^[1-9]\d{0,19}$/.test(String(value)) || BigInt(value) > 18446744073709551615n) fail();
    return String(value);
}
function uuid(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) fail();
    return value;
}
function recordAad(row, keyId) {
    if (!['rascunho','finalizacao','adendo','descarte'].includes(row.tipo) || Number(row.schema_version) !== 1) fail();
    return Buffer.from(JSON.stringify(['vitalis:clinical-record', 1, 'synthetic-ci',
        ...['clinica_id','paciente_id','consulta_id','profissional_id','registro_id','versao'].map(k=>canonicalId(row[k])),
        row.versao_anterior == null ? null : canonicalId(row.versao_anterior),
        canonicalId(row.autor_usuario_id), row.tipo, 1, uuid(keyId)]));
}
function wrapAad(clinic, keyId) {
    return Buffer.from(JSON.stringify(['vitalis:clinical-dek',1,'synthetic-ci',canonicalId(clinic),uuid(keyId)]));
}
function seal(bytes, key, aad) {
    if (!keyValid(key) || !Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES || !Buffer.isBuffer(aad)) fail();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});
    cipher.setAAD(aad);
    return { ciphertext:Buffer.concat([cipher.update(bytes),cipher.final()]), iv, tag:cipher.getAuthTag() };
}
function open(envelope, key, aad) {
    let partial, final;
    try {
        if (!keyValid(key) || !Buffer.isBuffer(envelope.ciphertext) || envelope.ciphertext.length > MAX_BYTES ||
            !Buffer.isBuffer(envelope.iv) || envelope.iv.length !== 12 ||
            !Buffer.isBuffer(envelope.tag) || envelope.tag.length !== 16 || !Buffer.isBuffer(aad)) fail();
        const decipher = createDecipheriv('aes-256-gcm',key,envelope.iv,{authTagLength:16});
        decipher.setAAD(aad); decipher.setAuthTag(envelope.tag);
        partial = decipher.update(envelope.ciphertext);
        final = decipher.final();
        return Buffer.concat([partial,final]);
    } catch { fail(); }
    finally { partial?.fill(0); final?.fill(0); }
}
function fixtureKek() {
    if (!fixtureEnabled()) fail();
    const encoded = process.env.CLINICAL_FIXTURE_KEK;
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) fail();
    const key = Buffer.from(encoded,'base64');
    if (!keyValid(key) || key.toString('base64') !== encoded) { key.fill(0); fail(); }
    return key;
}
async function historicalKey(connection, clinic, keyId) {
    const [rows] = await connection.execute('SELECT dek_protegida, wrap_iv, wrap_tag, formato FROM prontuario_chaves WHERE clinica_id=? AND chave_id=?',[clinic,keyId]);
    const row = rows[0];
    if (!row || Number(row.formato) !== 1) fail();
    const kek = fixtureKek();
    try {
        const key = open({ciphertext:row.dek_protegida,iv:row.wrap_iv,tag:row.wrap_tag},kek,wrapAad(clinic,keyId));
        if (!keyValid(key)) { key.fill(0); fail(); }
        return key;
    } finally { kek.fill(0); }
}
// Only called after acquiring the clinic row lock in the controller.
// This provider cannot be enabled for a commercial deployment.
async function activeKey(connection, clinic) {
    const [rows] = await connection.execute('SELECT chave_id FROM prontuario_chaves WHERE clinica_id=? AND ativa=1 FOR UPDATE',[clinic]);
    if (rows.length) return {id:rows[0].chave_id,key:await historicalKey(connection,clinic,rows[0].chave_id)};
    const kek = fixtureKek(), key = randomBytes(32), id = randomUUID();
    try {
        const wrapped = seal(key,kek,wrapAad(clinic,id));
        await connection.execute('INSERT INTO prontuario_chaves (clinica_id,chave_id,ativa,dek_protegida,wrap_iv,wrap_tag) VALUES (?,?,1,?,?,?)',
            [clinic,id,wrapped.ciphertext,wrapped.iv,wrapped.tag]);
        return {id,key};
    } catch (error) { key.fill(0); throw error; }
    finally { kek.fill(0); }
}
async function encryptVersion(connection, row, payload) {
    let active;
    try { active = await activeKey(connection,row.clinica_id); }
    catch { throw new CryptoWriteError('RECORD_KEY_FAILURE'); }
    const {id,key} = active;
    let bytes;
    try {
        bytes = Buffer.from(JSON.stringify(payload));
        let envelope;
        try { envelope = seal(bytes,key,recordAad(row,id)); }
        catch { throw new CryptoWriteError('RECORD_ENCRYPT_FAILURE'); }
        await connection.execute('INSERT INTO prontuario_envelopes (clinica_id,registro_id,versao,chave_id,conteudo_cifrado,iv,auth_tag,aad_version) VALUES (?,?,?,?,?,?,?,1)',
            [row.clinica_id,row.registro_id,row.versao,id,envelope.ciphertext,envelope.iv,envelope.tag]);
    } finally { bytes?.fill(0); key.fill(0); }
}
async function decryptVersion(connection, context, row) {
    if (Number(row.aad_version) !== 1) fail();
    const key = await historicalKey(connection,context.clinica_id,row.chave_id);
    let bytes;
    try {
        bytes = open({ciphertext:row.conteudo_cifrado,iv:row.iv,tag:row.auth_tag},key,
            recordAad({...context,...row},row.chave_id));
        const payload = JSON.parse(bytes.toString('utf8'));
        if (!payload || typeof payload.conteudo !== 'object' || !payload.conteudo ||
            typeof payload.autor_snapshot !== 'object' || !payload.autor_snapshot) fail();
        const {chave_id,conteudo_cifrado,iv,auth_tag,aad_version,...metadata} = row;
        return {...metadata,conteudo:payload.conteudo,autor_snapshot:payload.autor_snapshot};
    } catch { fail(); }
    finally { bytes?.fill(0); key.fill(0); }
}
module.exports = {syntheticEnabled,fixtureEnabled,enableSyntheticFixture,CryptoWriteError,TEST_SCHEMA,recordAad,seal,open,encryptVersion,decryptVersion};
