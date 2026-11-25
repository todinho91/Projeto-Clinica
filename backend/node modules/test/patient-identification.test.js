const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { test } = require('node:test');

const identification = require('../support/patient-identification');
const cepService = require('../services/cep-service');

function cryptoConfig() {
    return {
        encryptionKey: randomBytes(32),
        indexKey: randomBytes(32),
        keyId: 'test-key-v1'
    };
}

test('CPF aplica máscara, valida dígitos e rejeita sequências', () => {
    assert.equal(identification.formatCpf('52998224725'), '529.982.247-25');
    assert.equal(identification.isValidCpf('529.982.247-25'), true);
    for (const invalid of ['529.982.247-24', '111.111.111-11', '123', 'abcdefghijk']) {
        assert.equal(identification.isValidCpf(invalid), false, invalid);
    }
});

test('CPF é cifrado com autenticação e recebe índice isolado por tenant', () => {
    const config = cryptoConfig();
    const first = identification.protectCpf('529.982.247-25', 11, config);
    const second = identification.protectCpf('52998224725', 11, config);
    const otherTenant = identification.protectCpf('52998224725', 12, config);

    assert.equal(first.ciphertext.includes(Buffer.from('52998224725')), false);
    assert.equal(first.iv.equals(second.iv), false);
    assert.equal(first.ciphertext.equals(second.ciphertext), false);
    assert.equal(first.searchHash.equals(second.searchHash), true);
    assert.equal(first.searchHash.equals(otherTenant.searchHash), false);
    assert.equal(identification.revealCpf(first, 11, config), '52998224725');
    assert.throws(() => identification.revealCpf(first, 12, config));
    assert.equal(identification.maskedCpf(first.lastFour), '***.***.***-4725');
});

test('configuração de CPF exige duas chaves Base64 distintas do identificador', () => {
    const key = randomBytes(32).toString('base64');
    assert.throws(
        () => identification.cryptoConfiguration({ PATIENT_CPF_KEY_ID: 'v1' }),
        (error) => error.code === 'PATIENT_PROTECTION_CONFIG'
    );
    assert.throws(() => identification.cryptoConfiguration({
        PATIENT_CPF_KEY_ID: 'v1',
        PATIENT_CPF_ENCRYPTION_KEY: key,
        PATIENT_CPF_INDEX_KEY: key
    }), /devem ser distintas/);
    const config = identification.cryptoConfiguration({
        PATIENT_CPF_KEY_ID: 'cpf-2026-v1',
        PATIENT_CPF_ENCRYPTION_KEY: key,
        PATIENT_CPF_INDEX_KEY: randomBytes(32).toString('base64')
    });
    assert.equal(config.encryptionKey.length, 32);
    assert.equal(config.indexKey.length, 32);
    assert.equal(config.keyId, 'cpf-2026-v1');
});

test('identificação completa e exceções controladas não aceitam endereço parcial', () => {
    const complete = identification.identificationPayload({
        cpf: '529.982.247-25', cep: '86300-000', logradouro: 'Rua Teste', numero: '10',
        bairro: 'Centro', cidade: 'Cornélio Procópio', uf: 'pr', complemento: 'Sala 1'
    });
    assert.equal(complete.status, 'completo');
    assert.equal(complete.address.cep, '86300000');
    assert.equal(complete.address.state, 'PR');
    assert.equal(identification.identificationPayload({
        cpf: '52998224725', cep: '86300000', logradouro: 'Rua Teste', numero: '',
        bairro: 'Centro', cidade: 'Cornélio Procópio', uf: 'PR'
    }), null);
    const exception = identification.identificationPayload({
        cpf_excecao: 'nao_possui', endereco_excecao: 'sem_endereco_convencional'
    });
    assert.equal(exception.status, 'excecao');
    assert.equal(identification.identificationPayload({
        cpf_excecao: 'motivo_livre', endereco_excecao: 'urgencia'
    }), null);
});

test('proxy de CEP envia somente o CEP, normaliza resposta e trata inexistência', async () => {
    cepService.resetForTests();
    const calls = [];
    const found = await cepService.lookupCep('01001-000', {
        rateKey: '11:7',
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return {
                ok: true,
                json: async () => ({
                    cep: '01001-000', logradouro: 'Praça da Sé', bairro: 'Sé',
                    localidade: 'São Paulo', uf: 'SP'
                })
            };
        }
    });
    assert.deepEqual(found.address, {
        cep: '01001000', logradouro: 'Praça da Sé', bairro: 'Sé',
        cidade: 'São Paulo', uf: 'SP'
    });
    assert.equal(calls[0].url, 'https://viacep.com.br/ws/01001000/json/');
    assert.equal('body' in calls[0].options, false);
    assert.doesNotMatch(JSON.stringify(calls), /cpf|paciente|consulta/i);

    cepService.resetForTests();
    const missing = await cepService.lookupCep('99999999', {
        rateKey: '11:7', fetchImpl: async () => ({ ok: true, json: async () => ({ erro: true }) })
    });
    assert.equal(missing.kind, 'not_found');
});

test('proxy de CEP preserva fallback manual em falha e limita uso por operador', async () => {
    cepService.resetForTests();
    const unavailable = await cepService.lookupCep('01001000', {
        rateKey: '11:7', fetchImpl: async () => { throw new Error('offline'); }
    });
    assert.equal(unavailable.kind, 'unavailable');
    for (let index = 0; index < 30; index += 1) {
        await cepService.lookupCep(String(10000000 + index), {
            rateKey: '11:8', fetchImpl: async () => ({ ok: true, json: async () => ({ erro: true }) })
        });
    }
    const limited = await cepService.lookupCep('20000000', {
        rateKey: '11:8', fetchImpl: async () => ({ ok: true, json: async () => ({ erro: true }) })
    });
    assert.equal(limited.kind, 'limited');
});

test('proxy de CEP interrompe provedor lento no timeout configurado', async () => {
    cepService.resetForTests();
    let aborted = false;
    const result = await cepService.lookupCep('01001000', {
        rateKey: '11:9', timeoutMs: 5,
        fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                aborted = true;
                reject(new Error('aborted'));
            }, { once: true });
        })
    });
    assert.equal(aborted, true);
    assert.equal(result.kind, 'unavailable');
});

test('limiter de CEP mantém memória limitada e falha fechado quando cheio', () => {
    cepService.resetForTests();
    for (let index = 0; index < 10000; index += 1) {
        assert.equal(cepService.allowRequest(`operator-${index}`, 1000), true);
    }
    assert.equal(cepService.allowRequest('operator-over-capacity', 1000), false);
    assert.equal(cepService.allowRequest('operator-over-capacity', 61000), true);
});

test('cache de CEP remove entradas antigas quando atinge o limite', async () => {
    cepService.resetForTests();
    let providerCalls = 0;
    const fetchImpl = async () => {
        providerCalls += 1;
        return {
            ok: true,
            json: async () => ({ logradouro: 'Rua Teste', bairro: 'Centro', localidade: 'Curitiba', uf: 'PR' })
        };
    };
    for (let index = 0; index < 2049; index += 1) {
        const cep = String(10000000 + index);
        const result = await cepService.lookupCep(cep, {
            rateKey: `cache-operator-${index}`, now: 1000, fetchImpl
        });
        assert.equal(result.kind, 'found');
    }
    assert.equal(providerCalls, 2049);
    const first = await cepService.lookupCep('10000000', {
        rateKey: 'cache-operator-0', now: 1000, fetchImpl
    });
    assert.equal(first.kind, 'found');
    assert.equal(providerCalls, 2050);
});
