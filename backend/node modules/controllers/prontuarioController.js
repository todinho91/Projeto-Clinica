const { randomUUID } = require('node:crypto');
const pool = require('../config/database');
const { fixtureEnabled, CryptoWriteError, TEST_SCHEMA, encryptVersion, decryptVersion } = require('../support/clinical-record-crypto');
const { positiveId, onlyKeys, recordContent, addendumContent, eligible, canRead,
    nextState, completeForFinalization } = require('../support/clinical-record');

class RecordError extends Error {
    constructor(status, code, message) {
        super(message); this.status = status; this.code = code;
    }
}
function reject(status, code, message) { throw new RecordError(status, code, message); }
function invalid() { reject(400, 'RECORD_INVALID', 'Dados ou versão inválidos.'); }
function forbidden() { reject(403, 'RECORD_FORBIDDEN', 'Acesso clínico não autorizado.'); }
function missing() { reject(404, 'RECORD_NOT_FOUND', 'Registro não encontrado.'); }
function conflict() { reject(409, 'RECORD_CONFLICT', 'Registro ou consulta alterado. Atualize antes de continuar.'); }

async function first(connection, sql, params) {
    const [rows] = await connection.execute(sql, params);
    return rows[0] ?? null;
}

async function clinicalContext(connection, req) {
    const clinicId = positiveId(req.tenant?.clinicId);
    const userId = positiveId(req.userId);
    const version = positiveId(req.auth?.membershipVersion);
    if (!clinicId || !userId || !version || req.tenant?.role !== 'profissional'
        || req.auth?.tokenType !== 'clinic' || positiveId(req.auth.clinicId) !== clinicId) forbidden();
    // Revalidate in the transaction; keep membership first as in appointment status/rescheduling.
    const membership = await first(connection,
        "SELECT u.nome FROM clinica_usuarios cu JOIN usuarios u ON u.id = cu.usuario_id AND u.status = 'ativo' " +
        "WHERE cu.clinica_id = ? AND cu.usuario_id = ? AND cu.papel = 'profissional' " +
        "AND cu.status = 'ativo' AND cu.sessao_versao = ? LIMIT 1 FOR UPDATE", [clinicId, userId, version]);
    if (!membership) forbidden();
    if (!await first(connection, "SELECT id FROM clinicas WHERE id = ? AND status = 'ativa' FOR UPDATE", [clinicId])) forbidden();
    const profile = await first(connection,
        "SELECT id, nome_exibicao, tipo_profissional, conselho_tipo, conselho_numero FROM profissionais " +
        "WHERE clinica_id = ? AND usuario_id = ? AND status = 'ativo' LIMIT 1 FOR UPDATE", [clinicId, userId]);
    if (!profile) forbidden();
    const practice = await first(connection,
        "SELECT titular_usuario_id, status FROM consultorios_profissionais WHERE clinica_id = ? FOR UPDATE", [clinicId]);
    const identity = await first(connection,
        "SELECT status_verificacao, conselho_tipo, conselho_numero, conselho_uf FROM identidades_profissionais " +
        "WHERE usuario_id = ? FOR UPDATE", [userId]);
    if (identity?.status_verificacao === 'suspensa') forbidden();
    if (practice && (practice.status !== 'ativo' || Number(practice.titular_usuario_id) !== userId
        || identity?.status_verificacao !== 'verificada')) forbidden();
    return { clinicId, userId, professionalId: Number(profile.id), author: {
        nome: membership.nome, nome_exibicao: profile.nome_exibicao,
        tipo_profissional: profile.tipo_profissional, conselho_tipo: profile.conselho_tipo,
        conselho_numero: profile.conselho_numero,
        identidade_global: identity ? {
            status_verificacao: identity.status_verificacao, conselho_tipo: identity.conselho_tipo,
            conselho_numero: identity.conselho_numero, conselho_uf: identity.conselho_uf
        } : null
    } };
}

async function appointment(connection, ctx, id) {
    const row = await first(connection,
        "SELECT id, paciente_id, profissional_id, status, inicio_em, (inicio_em <= UTC_TIMESTAMP(6)) AS iniciado " +
        "FROM consultas WHERE clinica_id = ? AND id = ? AND profissional_id = ? LIMIT 1 FOR UPDATE",
        [ctx.clinicId, id, ctx.professionalId]);
    if (!row) missing();
    return row;
}

async function record(connection, ctx, id) {
    const row = await first(connection,
        "SELECT id, paciente_id, consulta_id, profissional_id, autor_usuario_id, estado, versao_atual, " +
        "atendimento_inicio_em, criado_em FROM prontuario_registros " +
        "WHERE clinica_id = ? AND id = ? AND profissional_id = ? AND autor_usuario_id = ? LIMIT 1 FOR UPDATE",
        [ctx.clinicId, id, ctx.professionalId, ctx.userId]);
    if (!row) missing();
    const appt = await appointment(connection, ctx, row.consulta_id);
    if (Number(appt.paciente_id) !== Number(row.paciente_id)) missing();
    return { row, appt };
}

async function currentVersion(connection, ctx, row) {
    const version = await first(connection,
        "SELECT v.versao, v.versao_anterior, v.tipo, v.autor_usuario_id, v.schema_version, v.criado_em, " +
        "e.chave_id, e.conteudo_cifrado, e.iv, e.auth_tag, e.aad_version " +
        "FROM prontuario_versoes v LEFT JOIN prontuario_envelopes e ON e.clinica_id=v.clinica_id AND e.registro_id=v.registro_id AND e.versao=v.versao " +
        "WHERE v.clinica_id = ? AND v.registro_id = ? AND v.versao = ?",
        [ctx.clinicId, row.id, row.versao_atual]);
    if (!version) reject(500, 'RECORD_INTEGRITY', 'Registro indisponível.');
    return decodeVersion(connection, ctx, row, version);
}

async function audit(connection, ctx, action, entity, id, version) {
    await connection.execute(
        "INSERT INTO auditoria (clinica_id, usuario_id, acao, entidade_tipo, entidade_id, request_id, metadados) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)", [ctx.clinicId, ctx.userId, action, entity, id, randomUUID(),
            JSON.stringify(version == null ? { resultado: 'permitido' } : { resultado: 'permitido', versao: version })]);
}

function versionContext(ctx,row) {
    return {clinica_id:ctx.clinicId,paciente_id:row.paciente_id,consulta_id:row.consulta_id,
        profissional_id:ctx.professionalId,registro_id:row.id};
}
async function decodeVersion(connection,ctx,row,version) {
    try { return await decryptVersion(connection,versionContext(ctx,row),version); }
    catch { reject(500,'RECORD_INTEGRITY','Registro indisponível.'); }
}
async function append(connection, ctx, row, version, type, content) {
    const previous = version === 1 ? null : version - 1;
    await connection.execute(
        "INSERT INTO prontuario_versoes (clinica_id, registro_id, versao, versao_anterior, tipo, autor_usuario_id, " +
        "schema_version, criado_em) VALUES (?, ?, ?, ?, ?, ?, 1, UTC_TIMESTAMP(6))",
        [ctx.clinicId, row.id, version, previous, type, ctx.userId]);
    await encryptVersion(connection,{...versionContext(ctx,row),versao:version,versao_anterior:previous,
        tipo:type,autor_usuario_id:ctx.userId,schema_version:1},{conteudo:content,autor_snapshot:ctx.author});
}
async function persistDenial(connection,code) {
    try {
        await connection.execute('INSERT INTO prontuario_negativas (codigo) VALUES (?)',[code]);
    } catch { console.warn('[prontuario] security_event_unavailable'); }
}
exports.recordRoleDenial = async (req,res,next) => {
    if (!fixtureEnabled() || req.tenant?.role === 'profissional') return next();
    let connection;
    try {
        connection = await pool.getConnection();
        const selected = await first(connection,'SELECT DATABASE() AS db',[]);
        if (selected?.db === TEST_SCHEMA) await persistDenial(connection,'RECORD_FORBIDDEN');
    } catch { console.warn('[prontuario] security_event_unavailable'); }
    finally { connection?.release(); }
    return res.status(403).json({code:'RECORD_FORBIDDEN',error:'Acesso clínico não autorizado.'});
};

function endpoint(operation) {
    return async (req, res) => {
        // Experimental backend: disabled by default until controlled synthetic validation.
        if (!fixtureEnabled()) {
            return res.status(503).json({ code: 'RECORD_DISABLED', error: 'Prontuário indisponível neste ambiente.' });
        }
        let connection;
        try {
            if (req.tenant?.role !== 'profissional') forbidden();
            connection = await pool.getConnection();
            const selected = await first(connection,'SELECT DATABASE() AS db',[]);
            if (selected?.db !== TEST_SCHEMA) forbidden();
            await connection.beginTransaction();
            const ctx = await clinicalContext(connection, req);
            const result = await operation(connection, ctx, req);
            await connection.commit();
            return res.status(result.status ?? 200).json(result.body);
        } catch (error) {
            if (connection) await connection.rollback().catch(() => {});
            if (error instanceof CryptoWriteError) {
                // A failed write has already rolled back. Do not include key, payload or target.
                if (connection) {
                    try {
                        const selected = await first(connection,'SELECT DATABASE() AS db',[]);
                        if (selected?.db === TEST_SCHEMA) await persistDenial(connection,error.code);
                    } catch { console.warn('[prontuario] security_event_unavailable'); }
                }
                return res.status(500).json({code:error.code,error:'Registro indisponível.'});
            }
            if (error instanceof RecordError) {
                // No untrusted IDs, clinical payloads or identifying data in denied-access logs.
                if (['RECORD_FORBIDDEN','RECORD_NOT_FOUND','RECORD_INTEGRITY'].includes(error.code)) {
                    // Record the event after rollback; never store the requested target or payload.
                    if (connection) {
                        try {
                            const selected = await first(connection,'SELECT DATABASE() AS db',[]);
                            if (selected?.db === TEST_SCHEMA) await persistDenial(connection,error.code);
                        } catch { console.warn('[prontuario] security_event_unavailable'); }
                    }
                }
                return res.status(error.status).json({ code: error.code, error: error.message });
            }
            if (['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error?.code)) {
                return res.status(409).json({ code: 'RECORD_CONFLICT', error: 'Operação concorrente. Atualize e tente novamente.' });
            }
            // Never log raw driver errors: SQL and parameter values may contain clinical data.
            console.error('[prontuario] operation_failed');
            return res.status(500).json({ code: 'RECORD_ERROR', error: 'Não foi possível concluir a operação.' });
        } finally { connection?.release(); }
    };
}

function page(query) {
    if (!onlyKeys(query ?? {}, ['pagina', 'limite'])) invalid();
    const number = positiveId(query?.pagina ?? 1);
    const limit = positiveId(query?.limite ?? 20);
    if (!number || number > 10000 || !limit || limit > 50) invalid();
    return { number, limit, offset: (number - 1) * limit };
}

exports.create = endpoint(async (connection, ctx, req) => {
    const id = positiveId(req.params.consultaId);
    if (!id || !onlyKeys(req.body ?? {}, ['conteudo'])) invalid();
    const content = recordContent(req.body?.conteudo ?? {});
    if (!content) invalid();
    const appt = await appointment(connection, ctx, id);
    if (!eligible(appt.status, appt.iniciado)) conflict();
    const existing = await first(connection,
        "SELECT id FROM prontuario_registros WHERE clinica_id = ? AND consulta_id = ? FOR UPDATE", [ctx.clinicId, id]);
    if (existing) conflict();
    const [insert] = await connection.execute(
        "INSERT INTO prontuario_registros (clinica_id, paciente_id, consulta_id, profissional_id, autor_usuario_id, " +
        "estado, versao_atual, atendimento_inicio_em, criado_em) " +
        "SELECT clinica_id, paciente_id, id, profissional_id, ?, 'rascunho', 1, inicio_em, UTC_TIMESTAMP(6) " +
        "FROM consultas WHERE clinica_id = ? AND id = ? AND profissional_id = ?",
        [ctx.userId, ctx.clinicId, id, ctx.professionalId]);
    await append(connection, ctx, {id:insert.insertId,paciente_id:appt.paciente_id,consulta_id:id}, 1, 'rascunho', content);
    await audit(connection, ctx, 'prontuario_criado', 'prontuario', insert.insertId, 1);
    return { status: 201, body: { id: Number(insert.insertId), estado: 'rascunho', versao: 1 } };
});

exports.detail = endpoint(async (connection, ctx, req) => {
    const id = positiveId(req.params.id); if (!id) invalid();
    const { row, appt } = await record(connection, ctx, id);
    if (!canRead(row.estado, appt.status, appt.iniciado)) missing();
    const version = await currentVersion(connection, ctx, row);
    await audit(connection, ctx, 'prontuario_lido', 'prontuario', id, version.versao);
    return { body: { registro: row, versao_atual: version } };
});

exports.timeline = endpoint(async (connection, ctx, req) => {
    const id = positiveId(req.params.pacienteId); if (!id) invalid();
    const p = page(req.query);
    const relation = await first(connection,
        "SELECT c.id FROM consultas c WHERE c.clinica_id = ? AND c.paciente_id = ? AND c.profissional_id = ? " +
        "AND (c.status = 'realizada' OR (c.status IN ('agendada','confirmada') AND c.inicio_em <= UTC_TIMESTAMP(6))) " +
        "ORDER BY c.id LIMIT 1 FOR UPDATE", [ctx.clinicId, id, ctx.professionalId]);
    if (!relation && !await first(connection,
        "SELECT id FROM prontuario_registros WHERE clinica_id = ? AND paciente_id = ? AND profissional_id = ? " +
        "AND autor_usuario_id = ? AND estado = 'finalizado' LIMIT 1 FOR UPDATE",
        [ctx.clinicId, id, ctx.professionalId, ctx.userId])) missing();
    const [rows] = await connection.execute(
        "SELECT r.id, r.consulta_id, r.estado, r.versao_atual, r.atendimento_inicio_em, r.criado_em " +
        "FROM prontuario_registros r JOIN consultas c ON c.clinica_id = r.clinica_id AND c.id = r.consulta_id " +
        "WHERE r.clinica_id = ? AND r.paciente_id = ? AND r.profissional_id = ? AND r.autor_usuario_id = ? " +
        "AND (r.estado = 'finalizado' OR (r.estado = 'rascunho' AND (c.status = 'realizada' OR " +
        "(c.status IN ('agendada','confirmada') AND c.inicio_em <= UTC_TIMESTAMP(6))))) " +
        "ORDER BY r.atendimento_inicio_em DESC, r.id DESC LIMIT ? OFFSET ? FOR UPDATE",
        [ctx.clinicId, id, ctx.professionalId, ctx.userId, p.limit + 1, p.offset]);
    await audit(connection, ctx, 'prontuario_linha_tempo_lida', 'paciente', id, null);
    return { body: { itens: rows.slice(0, p.limit), pagina: p.number, tem_proxima: rows.length > p.limit } };
});

exports.versions = endpoint(async (connection, ctx, req) => {
    const id = positiveId(req.params.id); if (!id) invalid();
    const p = page(req.query);
    const { row, appt } = await record(connection, ctx, id);
    if (!canRead(row.estado, appt.status, appt.iniciado)) missing();
    const [rows] = await connection.execute(
        "SELECT v.versao, v.versao_anterior, v.tipo, v.autor_usuario_id, v.schema_version, v.criado_em, " +
        "e.chave_id, e.conteudo_cifrado, e.iv, e.auth_tag, e.aad_version " +
        "FROM prontuario_versoes v LEFT JOIN prontuario_envelopes e ON e.clinica_id=v.clinica_id AND e.registro_id=v.registro_id AND e.versao=v.versao " +
        "WHERE v.clinica_id = ? AND v.registro_id = ? ORDER BY v.versao DESC LIMIT ? OFFSET ?",
        [ctx.clinicId, id, p.limit + 1, p.offset]);
    const items = [];
    for (const version of rows.slice(0,p.limit)) items.push(await decodeVersion(connection,ctx,row,version));
    await audit(connection, ctx, 'prontuario_historico_lido', 'prontuario', id, row.versao_atual);
    return { body: { itens: items, pagina: p.number, tem_proxima: rows.length > p.limit } };
});

function mutation(action) {
    return endpoint(async (connection, ctx, req) => {
        const id = positiveId(req.params.id);
        const expected = positiveId(req.body?.versao);
        const acceptsContent = action === 'rascunho' || action === 'adendo';
        if (!id || !expected || !onlyKeys(req.body, acceptsContent ? ['versao', 'conteudo'] : ['versao'])) invalid();
        const { row, appt } = await record(connection, ctx, id);
        if (!eligible(appt.status, appt.iniciado)) conflict();
        const target = nextState(row.estado, action);
        if (!target || Number(row.versao_atual) !== expected || expected >= 4294967295) conflict();
        const previous = await currentVersion(connection, ctx, row);
        const oldContent = typeof previous.conteudo === 'string' ? JSON.parse(previous.conteudo) : previous.conteudo;
        const content = action === 'rascunho' ? recordContent(req.body.conteudo)
            : action === 'adendo' ? addendumContent(req.body.conteudo) : oldContent;
        if (!content) invalid();
        if (action === 'finalizacao' && !completeForFinalization(content, ctx.author)) {
            reject(422, 'RECORD_INCOMPLETE', 'Informe evolução, conduta e identificação profissional antes de finalizar.');
        }
        const next = expected + 1;
        await append(connection, ctx, row, next, action, content);
        const [updated] = await connection.execute(
            "UPDATE prontuario_registros SET estado = ?, versao_atual = ? WHERE clinica_id = ? AND id = ? " +
            "AND autor_usuario_id = ? AND versao_atual = ?",
            [target, next, ctx.clinicId, id, ctx.userId, expected]);
        if (updated.affectedRows !== 1) conflict();
        const event = { rascunho: 'prontuario_rascunho_versionado', finalizacao: 'prontuario_finalizado',
            adendo: 'prontuario_adendo', descarte: 'prontuario_rascunho_descartado' }[action];
        await audit(connection, ctx, event, 'prontuario', id, next);
        return { body: { id, estado: target, versao: next } };
    });
}
exports.saveDraft = mutation('rascunho');
exports.finalize = mutation('finalizacao');
exports.addendum = mutation('adendo');
exports.discard = mutation('descarte');
