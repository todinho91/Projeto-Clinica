const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const patterns = [
    { name: 'chave privada', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
    { name: 'chave de acesso AWS', regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
    {
        name: 'segredo configurado em arquivo',
        regex: /^(?:DB_PASSWORD|JWT_SECRET|SEED_PASSWORD|TEST_DB_PASSWORD)[ \t]*=[ \t]*[^ \t\r\n#<][^\r\n]*$/gm
    }
];

function scanText(text) {
    return patterns.flatMap(({ name, regex }) => {
        regex.lastIndex = 0;
        return [...text.matchAll(regex)].map((match) => ({ name, index: match.index }));
    });
}

function trackedFiles(repositoryRoot) {
    return execFileSync('git', ['ls-files', '-z'], {
        cwd: repositoryRoot,
        encoding: 'utf8'
    }).split('\0').filter(Boolean);
}

function scanRepository(repositoryRoot) {
    const ignoredFixtures = new Set([
        'backend/node modules/test/secret-scan.test.js'
    ]);
    const findings = [];
    for (const relativePath of trackedFiles(repositoryRoot)) {
        if (ignoredFixtures.has(relativePath)) continue;
        const contents = readFileSync(path.join(repositoryRoot, relativePath));
        if (contents.includes(0)) continue;
        for (const finding of scanText(contents.toString('utf8'))) {
            findings.push({ path: relativePath, ...finding });
        }
    }
    return findings;
}

if (require.main === module) {
    const repositoryRoot = path.resolve(__dirname, '..', '..', '..', '..');
    const findings = scanRepository(repositoryRoot);
    if (findings.length > 0) {
        findings.forEach((finding) => console.error(`${finding.path}: possível ${finding.name}`));
        process.exitCode = 1;
    } else {
        console.info('Nenhum padrão de segredo conhecido encontrado na árvore rastreada.');
    }
}

module.exports = { scanRepository, scanText };
