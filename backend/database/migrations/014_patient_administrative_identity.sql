CREATE TABLE IF NOT EXISTS pacientes_identificacao_administrativa (
    clinica_id BIGINT UNSIGNED NOT NULL,
    paciente_id BIGINT UNSIGNED NOT NULL,
    cadastro_status ENUM('pendente', 'completo', 'excecao') NOT NULL DEFAULT 'pendente',
    cpf_cifrado VARBINARY(64) NULL,
    cpf_iv BINARY(12) NULL,
    cpf_auth_tag BINARY(16) NULL,
    cpf_busca_hash BINARY(32) NULL,
    cpf_final CHAR(4) NULL,
    cpf_chave_id VARCHAR(64) NULL,
    cpf_excecao ENUM('nao_possui', 'urgencia', 'outro_justificado') NULL,
    cep CHAR(8) NULL,
    logradouro VARCHAR(160) NULL,
    numero VARCHAR(30) NULL,
    complemento VARCHAR(120) NULL,
    bairro VARCHAR(100) NULL,
    cidade VARCHAR(100) NULL,
    uf CHAR(2) NULL,
    endereco_excecao ENUM('sem_endereco_convencional', 'urgencia', 'outro_justificado') NULL,
    atualizado_por_usuario_id BIGINT UNSIGNED NOT NULL,
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (clinica_id, paciente_id),
    UNIQUE KEY uk_paciente_cpf_tenant (clinica_id, cpf_busca_hash),
    KEY idx_paciente_cadastro_status (clinica_id, cadastro_status, paciente_id),
    CONSTRAINT chk_paciente_cpf_protegido CHECK (
        (
            cpf_cifrado IS NOT NULL AND cpf_iv IS NOT NULL AND cpf_auth_tag IS NOT NULL
            AND cpf_busca_hash IS NOT NULL AND cpf_final IS NOT NULL
            AND cpf_chave_id IS NOT NULL AND cpf_excecao IS NULL
        ) OR (
            cpf_cifrado IS NULL AND cpf_iv IS NULL AND cpf_auth_tag IS NULL
            AND cpf_busca_hash IS NULL AND cpf_final IS NULL
            AND cpf_chave_id IS NULL AND cpf_excecao IS NOT NULL
        ) OR (
            cadastro_status = 'pendente'
            AND cpf_cifrado IS NULL AND cpf_iv IS NULL AND cpf_auth_tag IS NULL
            AND cpf_busca_hash IS NULL AND cpf_final IS NULL
            AND cpf_chave_id IS NULL AND cpf_excecao IS NULL
        )
    ),
    CONSTRAINT chk_paciente_endereco CHECK (
        (
            cep IS NOT NULL AND logradouro IS NOT NULL AND numero IS NOT NULL
            AND bairro IS NOT NULL AND cidade IS NOT NULL AND uf IS NOT NULL
            AND endereco_excecao IS NULL
        ) OR (
            cep IS NULL AND logradouro IS NULL AND numero IS NULL
            AND bairro IS NULL AND cidade IS NULL AND uf IS NULL
            AND complemento IS NULL AND endereco_excecao IS NOT NULL
        ) OR (
            cadastro_status = 'pendente'
            AND cep IS NULL AND logradouro IS NULL AND numero IS NULL
            AND bairro IS NULL AND cidade IS NULL AND uf IS NULL
            AND complemento IS NULL AND endereco_excecao IS NULL
        )
    ),
    CONSTRAINT chk_paciente_status_identificacao CHECK (
        (cadastro_status = 'completo' AND cpf_excecao IS NULL AND endereco_excecao IS NULL)
        OR (cadastro_status = 'excecao'
            AND (cpf_excecao IS NOT NULL OR endereco_excecao IS NOT NULL))
        OR (cadastro_status = 'pendente'
            AND cpf_cifrado IS NULL AND cpf_iv IS NULL AND cpf_auth_tag IS NULL
            AND cpf_busca_hash IS NULL AND cpf_final IS NULL AND cpf_chave_id IS NULL
            AND cpf_excecao IS NULL
            AND cep IS NULL AND logradouro IS NULL AND numero IS NULL
            AND complemento IS NULL AND bairro IS NULL AND cidade IS NULL AND uf IS NULL
            AND endereco_excecao IS NULL)
    ),
    CONSTRAINT fk_paciente_identificacao_paciente
        FOREIGN KEY (clinica_id, paciente_id) REFERENCES pacientes (clinica_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_paciente_identificacao_operador
        FOREIGN KEY (atualizado_por_usuario_id) REFERENCES usuarios (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
