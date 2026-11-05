CREATE TABLE IF NOT EXISTS especialidades (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    clinica_id BIGINT UNSIGNED NOT NULL,
    nome VARCHAR(120) NOT NULL,
    status ENUM('ativa', 'inativa') NOT NULL DEFAULT 'ativa',
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_especialidades_tenant_id (clinica_id, id),
    UNIQUE KEY uk_especialidades_nome (clinica_id, nome),
    CONSTRAINT fk_especialidades_clinica
        FOREIGN KEY (clinica_id) REFERENCES clinicas (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS profissionais (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    clinica_id BIGINT UNSIGNED NOT NULL,
    usuario_id BIGINT UNSIGNED NOT NULL,
    nome_exibicao VARCHAR(160) NOT NULL,
    conselho_tipo VARCHAR(30) NULL,
    conselho_numero VARCHAR(40) NULL,
    status ENUM('ativo', 'inativo') NOT NULL DEFAULT 'ativo',
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_profissionais_tenant_id (clinica_id, id),
    UNIQUE KEY uk_profissionais_usuario (clinica_id, usuario_id),
    UNIQUE KEY uk_profissionais_conselho (clinica_id, conselho_tipo, conselho_numero),
    CONSTRAINT fk_profissionais_clinica
        FOREIGN KEY (clinica_id) REFERENCES clinicas (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_profissionais_vinculo
        FOREIGN KEY (clinica_id, usuario_id)
        REFERENCES clinica_usuarios (clinica_id, usuario_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS profissional_especialidades (
    clinica_id BIGINT UNSIGNED NOT NULL,
    profissional_id BIGINT UNSIGNED NOT NULL,
    especialidade_id BIGINT UNSIGNED NOT NULL,
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (clinica_id, profissional_id, especialidade_id),
    KEY idx_profissional_especialidades_especialidade (clinica_id, especialidade_id),
    CONSTRAINT fk_profissional_especialidades_profissional
        FOREIGN KEY (clinica_id, profissional_id)
        REFERENCES profissionais (clinica_id, id)
        ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT fk_profissional_especialidades_especialidade
        FOREIGN KEY (clinica_id, especialidade_id)
        REFERENCES especialidades (clinica_id, id)
        ON UPDATE RESTRICT ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS pacientes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    clinica_id BIGINT UNSIGNED NOT NULL,
    usuario_id BIGINT UNSIGNED NULL,
    nome VARCHAR(160) NOT NULL,
    email VARCHAR(254) NULL,
    telefone VARCHAR(30) NULL,
    data_nascimento DATE NULL,
    status ENUM('ativo', 'inativo') NOT NULL DEFAULT 'ativo',
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_pacientes_tenant_id (clinica_id, id),
    UNIQUE KEY uk_pacientes_usuario (clinica_id, usuario_id),
    KEY idx_pacientes_nome (clinica_id, nome),
    CONSTRAINT fk_pacientes_clinica
        FOREIGN KEY (clinica_id) REFERENCES clinicas (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_pacientes_vinculo
        FOREIGN KEY (clinica_id, usuario_id)
        REFERENCES clinica_usuarios (clinica_id, usuario_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS consultas (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    clinica_id BIGINT UNSIGNED NOT NULL,
    paciente_id BIGINT UNSIGNED NOT NULL,
    profissional_id BIGINT UNSIGNED NOT NULL,
    inicio_em DATETIME(6) NOT NULL,
    fim_em DATETIME(6) NOT NULL,
    status ENUM('agendada', 'confirmada', 'realizada', 'cancelada', 'nao_compareceu') NOT NULL DEFAULT 'agendada',
    criado_por_usuario_id BIGINT UNSIGNED NOT NULL,
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_consultas_tenant_id (clinica_id, id),
    UNIQUE KEY uk_consultas_inicio_profissional (clinica_id, profissional_id, inicio_em),
    KEY idx_consultas_paciente_data (clinica_id, paciente_id, inicio_em),
    KEY idx_consultas_status_data (clinica_id, status, inicio_em),
    CONSTRAINT chk_consultas_periodo CHECK (fim_em > inicio_em),
    CONSTRAINT fk_consultas_clinica
        FOREIGN KEY (clinica_id) REFERENCES clinicas (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_consultas_paciente
        FOREIGN KEY (clinica_id, paciente_id)
        REFERENCES pacientes (clinica_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_consultas_profissional
        FOREIGN KEY (clinica_id, profissional_id)
        REFERENCES profissionais (clinica_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_consultas_criador
        FOREIGN KEY (clinica_id, criado_por_usuario_id)
        REFERENCES clinica_usuarios (clinica_id, usuario_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS documentos_clinicos (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    clinica_id BIGINT UNSIGNED NOT NULL,
    paciente_id BIGINT UNSIGNED NOT NULL,
    titulo VARCHAR(180) NOT NULL,
    storage_key VARCHAR(500) NOT NULL,
    mime_type VARCHAR(120) NOT NULL,
    tamanho_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    sha256_hex CHAR(64) NULL,
    status ENUM('ativo', 'arquivado', 'sintetico') NOT NULL DEFAULT 'ativo',
    enviado_por_usuario_id BIGINT UNSIGNED NOT NULL,
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_documentos_tenant_id (clinica_id, id),
    UNIQUE KEY uk_documentos_storage_key (clinica_id, storage_key),
    KEY idx_documentos_paciente_data (clinica_id, paciente_id, criado_em),
    CONSTRAINT chk_documentos_tamanho CHECK (tamanho_bytes >= 0),
    CONSTRAINT fk_documentos_clinica
        FOREIGN KEY (clinica_id) REFERENCES clinicas (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_documentos_paciente
        FOREIGN KEY (clinica_id, paciente_id)
        REFERENCES pacientes (clinica_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_documentos_autor
        FOREIGN KEY (clinica_id, enviado_por_usuario_id)
        REFERENCES clinica_usuarios (clinica_id, usuario_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
