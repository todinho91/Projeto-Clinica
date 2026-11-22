CREATE TABLE IF NOT EXISTS identidades_profissionais (
    usuario_id BIGINT UNSIGNED NOT NULL,
    tipo_profissional VARCHAR(80) NOT NULL,
    conselho_tipo VARCHAR(30) NOT NULL,
    conselho_numero VARCHAR(40) NOT NULL,
    conselho_uf CHAR(2) NOT NULL,
    status_verificacao ENUM('pendente', 'verificada', 'suspensa') NOT NULL DEFAULT 'pendente',
    verificado_por_operador_id BIGINT UNSIGNED NULL,
    verificado_em TIMESTAMP(6) NULL,
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (usuario_id),
    UNIQUE KEY uk_identidades_profissionais_conselho
        (conselho_tipo, conselho_numero, conselho_uf),
    CONSTRAINT fk_identidades_profissionais_usuario
        FOREIGN KEY (usuario_id) REFERENCES usuarios (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_identidades_profissionais_verificador
        FOREIGN KEY (verificado_por_operador_id) REFERENCES operadores_plataforma (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS consultorios_profissionais (
    clinica_id BIGINT UNSIGNED NOT NULL,
    titular_usuario_id BIGINT UNSIGNED NOT NULL,
    status ENUM('ativo', 'inativo') NOT NULL DEFAULT 'ativo',
    catalogo_status ENUM('privado', 'pendente', 'publicavel') NOT NULL DEFAULT 'privado',
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (clinica_id),
    UNIQUE KEY uk_consultorios_titular (titular_usuario_id),
    CONSTRAINT fk_consultorios_clinica
        FOREIGN KEY (clinica_id) REFERENCES clinicas (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_consultorios_titular
        FOREIGN KEY (clinica_id, titular_usuario_id)
        REFERENCES clinica_usuarios (clinica_id, usuario_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS consultorio_locais (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    clinica_id BIGINT UNSIGNED NOT NULL,
    nome VARCHAR(120) NOT NULL,
    endereco_linha VARCHAR(200) NOT NULL,
    cidade VARCHAR(120) NOT NULL,
    uf CHAR(2) NOT NULL,
    cep VARCHAR(8) NULL,
    status ENUM('ativo', 'inativo') NOT NULL DEFAULT 'ativo',
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_consultorio_locais_tenant_id (clinica_id, id),
    UNIQUE KEY uk_consultorio_locais_nome (clinica_id, nome),
    CONSTRAINT fk_consultorio_locais_consultorio
        FOREIGN KEY (clinica_id) REFERENCES consultorios_profissionais (clinica_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
