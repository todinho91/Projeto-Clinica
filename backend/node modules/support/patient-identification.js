const {
    createCipheriv,
    createDecipheriv,
    createHmac,
    randomBytes,
    timingSafeEqual
} = require('node:crypto');

const CPF_EXCEPTIONS = new Set(['nao_possui', 'urgencia', 'outro_justificado']);
const ADDRESS_EXCEPTIONS = new Set(['sem_endereco_convencional', 'urgencia', 'outro_justificado']);
const UF = new Set([
    'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG',
    'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'
]);

function digits(value) {
    return typeof value === 'string' ? value.replace(/\D/g, '') : '';
}

function isValidCpf(value) {
    const cpf = digits(value);
    if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
    const verifier = (length) => {
        let sum = 0;
        for (let index = 0; index < length; index += 1) {
            sum += Number(cpf[index]) * (length + 1 - index);
        }
        const remainder = (sum * 10) % 11;
        return remainder === 10 ? 0 : remainder;
    };
    return verifier(9) === Number(cpf[9]) && verifier(10) === Number(cpf[10]);
}

function formatCpf(value) {
    const cpf = digits(value).slice(0, 11);
    return cpf.replace(/^(\d{3})(\d)/, '$1.$2')
        .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
        .replace(/\.(\d{3})(\d)/, '.$1-$2');
}

function formatCep(value) {
    const cep = digits(value).slice(0, 8);
    return cep.replace(/^(\d{5})(\d)/, '$1-$2');
}

function normalizedText(value, min, max) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/\s+/g, ' ');
    return normalized.length >= min && normalized.length <= max ? normalized : null;
}

function configurationFailure(message) {
    const error = new Error(message);
    error.code = 'PATIENT_PROTECTION_CONFIG';
    return error;
}

function decodeKey(name, env = process.env) {
    const raw = env[name];
    if (!raw || !raw.trim()) throw configurationFailure(`Configuração obrigatória ausente: ${name}`);
    const key = Buffer.from(raw.trim(), 'base64');
    if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== raw.trim().replace(/=+$/, '')) {
        throw configurationFailure(`${name} deve conter exatamente 32 bytes em Base64.`);
    }
    return key;
}

function cryptoConfiguration(env = process.env) {
    const keyId = env.PATIENT_CPF_KEY_ID?.trim();
    if (!keyId || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
        throw configurationFailure(
            'PATIENT_CPF_KEY_ID deve identificar a chave ativa sem conter o segredo.'
        );
    }
    const encryptionKey = decodeKey('PATIENT_CPF_ENCRYPTION_KEY', env);
    const indexKey = decodeKey('PATIENT_CPF_INDEX_KEY', env);
    if (timingSafeEqual(encryptionKey, indexKey)) {
        throw configurationFailure('As chaves de cifra e índice de CPF devem ser distintas.');
    }
    return { encryptionKey, indexKey, keyId };
}

function cpfSearchHash(cpf, clinicId, indexKey) {
    if (!isValidCpf(cpf) || !Number.isSafeInteger(Number(clinicId)) || Number(clinicId) <= 0) {
        throw new Error('CPF ou tenant inválido para indexação.');
    }
    return createHmac('sha256', indexKey)
        .update(`vitalis:cpf:v1:${Number(clinicId)}:${digits(cpf)}`, 'utf8')
        .digest();
}

function protectCpf(cpf, clinicId, configuration = cryptoConfiguration()) {
    const normalized = digits(cpf);
    if (!isValidCpf(normalized)) throw new Error('CPF inválido.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', configuration.encryptionKey, iv);
    cipher.setAAD(Buffer.from(`vitalis:cpf:v1:${Number(clinicId)}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
    return {
        ciphertext,
        iv,
        authTag: cipher.getAuthTag(),
        searchHash: cpfSearchHash(normalized, clinicId, configuration.indexKey),
        lastFour: normalized.slice(-4),
        keyId: configuration.keyId
    };
}

function revealCpf(protectedValue, clinicId, configuration) {
    if (protectedValue.keyId !== configuration.keyId) {
        throw new Error('A chave solicitada não corresponde ao identificador armazenado.');
    }
    const decipher = createDecipheriv(
        'aes-256-gcm', configuration.encryptionKey, protectedValue.iv
    );
    decipher.setAAD(Buffer.from(`vitalis:cpf:v1:${Number(clinicId)}`, 'utf8'));
    decipher.setAuthTag(protectedValue.authTag);
    return Buffer.concat([
        decipher.update(protectedValue.ciphertext), decipher.final()
    ]).toString('utf8');
}

function hashMatches(first, second) {
    return Buffer.isBuffer(first) && Buffer.isBuffer(second)
        && first.length === second.length && timingSafeEqual(first, second);
}

function identificationPayload(body = {}, options = {}) {
    const cpfException = body.cpf_excecao || null;
    const addressException = body.endereco_excecao || null;
    const cpfRaw = digits(body.cpf);
    const cep = digits(body.cep);
    const hasIdentificationInput = Boolean(
        cpfRaw || cpfException || cep || addressException || body.logradouro || body.numero
        || body.bairro || body.cidade || body.uf || body.complemento
    );
    if (!hasIdentificationInput && options.allowPending === true) {
        return { pending: true, status: 'pendente' };
    }

    let cpf = null;
    let preserveCpf = false;
    if (cpfException) {
        if (!CPF_EXCEPTIONS.has(cpfException) || cpfRaw) return null;
    } else if (cpfRaw) {
        if (!isValidCpf(cpfRaw)) return null;
        cpf = cpfRaw;
    } else if (options.existingCpf === true && body.preservar_cpf === true) {
        preserveCpf = true;
    } else {
        return null;
    }

    let address = null;
    const complement = normalizedText(body.complemento ?? '', 1, 120);
    if (addressException) {
        if (!ADDRESS_EXCEPTIONS.has(addressException)
            || cep || body.logradouro || body.numero || body.bairro || body.cidade || body.uf
            || complement) return null;
    } else {
        const street = normalizedText(body.logradouro, 2, 160);
        const number = normalizedText(body.numero, 1, 30);
        const district = normalizedText(body.bairro, 1, 100);
        const city = normalizedText(body.cidade, 2, 100);
        const state = typeof body.uf === 'string' ? body.uf.trim().toUpperCase() : '';
        if (!/^\d{8}$/.test(cep) || !street || !number || !district || !city || !UF.has(state)) {
            return null;
        }
        address = { cep, street, number, complement, district, city, state };
    }

    return {
        pending: false,
        status: cpfException || addressException ? 'excecao' : 'completo',
        cpf,
        preserveCpf,
        cpfException,
        address,
        addressException
    };
}

function maskedCpf(lastFour) {
    return /^\d{4}$/.test(String(lastFour || '')) ? `***.***.***-${lastFour}` : null;
}

module.exports = {
    ADDRESS_EXCEPTIONS,
    CPF_EXCEPTIONS,
    cryptoConfiguration,
    cpfSearchHash,
    digits,
    formatCep,
    formatCpf,
    hashMatches,
    identificationPayload,
    isValidCpf,
    maskedCpf,
    protectCpf,
    revealCpf
};
