module.exports = {
    clinicas: [
        {
            slug: 'aurora-demo',
            nome: 'Clínica Aurora Demo',
            usuarios: {
                administrador: { nome: 'Administrador Aurora Demo', email: 'admin.aurora@example.test' },
                secretaria: { nome: 'Secretaria Aurora Demo', email: 'secretaria.aurora@example.test' },
                profissional: { nome: 'Profissional Aurora Demo', email: 'profissional.aurora@example.test' },
                paciente: { nome: 'Paciente Aurora Demo', email: 'paciente.aurora@example.test' }
            },
            especialidade: 'Clínica Geral Demo',
            consulta: {
                inicio: '2030-01-15 13:00:00.000000',
                fim: '2030-01-15 13:45:00.000000'
            },
            documento: {
                titulo: 'Documento sintético sem conteúdo clínico',
                storageKey: 'synthetic/aurora-demo/documento-vazio.txt'
            }
        },
        {
            slug: 'horizonte-demo',
            nome: 'Espaço Horizonte Saúde Demo',
            usuarios: {
                administrador: { nome: 'Administrador Horizonte Demo', email: 'admin.horizonte@example.test' },
                secretaria: { nome: 'Secretaria Horizonte Demo', email: 'secretaria.horizonte@example.test' },
                profissional: { nome: 'Profissional Horizonte Demo', email: 'profissional.horizonte@example.test' },
                paciente: { nome: 'Paciente Horizonte Demo', email: 'paciente.horizonte@example.test' }
            },
            especialidade: 'Fisioterapia Demo',
            consulta: {
                inicio: '2030-01-16 14:00:00.000000',
                fim: '2030-01-16 14:45:00.000000'
            },
            documento: {
                titulo: 'Documento sintético sem conteúdo clínico',
                storageKey: 'synthetic/horizonte-demo/documento-vazio.txt'
            }
        }
    ]
};
