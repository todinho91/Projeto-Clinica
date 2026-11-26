const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomBytes, randomUUID } = require('node:crypto');
const { syntheticEnabled, recordAad, seal, open } = require('../support/clinical-record-crypto');
const context = {clinica_id:1,paciente_id:2,consulta_id:3,profissional_id:4,registro_id:5,
    versao:2,versao_anterior:1,autor_usuario_id:6,tipo:'rascunho',schema_version:1};

test('AES-GCM autentica conteúdo e todos os campos do AAD',()=>{
    const key=randomBytes(32), keyId=randomUUID(), aad=recordAad(context,keyId);
    const payload=Buffer.from(JSON.stringify({conteudo:{evolucao:'Fictício'},autor_snapshot:{nome:'Fixture'}}));
    const sealed=seal(payload,key,aad);
    assert.deepEqual(open(sealed,key,aad),payload);
    const second=seal(payload,key,aad);
    assert.notDeepEqual(second.iv,sealed.iv);
    assert.notDeepEqual(second.ciphertext,sealed.ciphertext);
    for(const field of ['clinica_id','paciente_id','consulta_id','profissional_id','registro_id','versao','versao_anterior','autor_usuario_id']) {
        assert.throws(()=>open(sealed,key,recordAad({...context,[field]:99},keyId)),/RECORD_CRYPTO_FAILURE/);
    }
    assert.throws(()=>open(sealed,key,recordAad({...context,tipo:'adendo'},keyId)),/RECORD_CRYPTO_FAILURE/);
    assert.throws(()=>open(sealed,key,recordAad(context,randomUUID())),/RECORD_CRYPTO_FAILURE/);
    for(const field of ['ciphertext','iv','tag']) {
        const changed=Buffer.from(sealed[field]); changed[0]^=1;
        assert.throws(()=>open({...sealed,[field]:changed},key,aad),/RECORD_CRYPTO_FAILURE/);
    }
    assert.throws(()=>open(sealed,randomBytes(32),aad),/RECORD_CRYPTO_FAILURE/);
    assert.throws(()=>recordAad({...context,registro_id:9007199254740992},keyId),/RECORD_CRYPTO_FAILURE/);
    assert.notDeepEqual(recordAad({...context,registro_id:'9007199254740993'},keyId),recordAad({...context,registro_id:'9007199254740994'},keyId));
    assert.throws(()=>seal(Buffer.alloc(65537),key,aad),/RECORD_CRYPTO_FAILURE/);
    key.fill(0);
});
test('provedor sintético exige combinação explícita de ambiente e banco descartável',()=>{
    const env={VITALIS_CLINICAL_RECORDS_ENABLED:'1',NODE_ENV:'test',CLINICAL_RECORD_INTEGRATION_TEST:'1',
        DB_DATABASE:'vitalis_prontuarios_ci_test',DB_HOST:'127.0.0.1'};
    assert.equal(syntheticEnabled(env),true);
    for(const field of Object.keys(env)) assert.equal(syntheticEnabled({...env,[field]:'invalid'}),false);
    assert.equal(syntheticEnabled({...env,NODE_ENV:'production'}),false);
    assert.equal(syntheticEnabled({...env,DB_DATABASE:'vitalis_m3_validacao'}),false);
});

test('variáveis de ambiente sozinhas não autorizam o provedor de fixture',()=>{
    const {fixtureEnabled}=require('../support/clinical-record-crypto');
    assert.equal(fixtureEnabled(),false);
});
