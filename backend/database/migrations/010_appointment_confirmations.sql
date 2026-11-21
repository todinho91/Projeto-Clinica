ALTER TABLE pacientes
    ADD COLUMN preferencia_contato ENUM('nenhum', 'whatsapp', 'telefone', 'email')
        NOT NULL DEFAULT 'nenhum' AFTER telefone;

CREATE TABLE IF NOT EXISTS confirmacoes_consulta (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    clinica_id BIGINT UNSIGNED NOT NULL,
    consulta_id BIGINT UNSIGNED NOT NULL,
    consulta_versao INT UNSIGNED NOT NULL,
    canal ENUM('whatsapp', 'aplicativo', 'push', 'manual') NOT NULL,
    estado ENUM('preparada', 'confirmada', 'recusada', 'expirada', 'revogada') NOT NULL,
    estado_entrega ENUM('nao_enviado', 'aceito_provedor', 'entrega_confirmada', 'falha')
        NOT NULL DEFAULT 'nao_enviado',
    token_hash CHAR(64) NULL,
    expira_em DATETIME(6) NULL,
    solicitado_por_usuario_id BIGINT UNSIGNED NOT NULL,
    respondido_por_usuario_id BIGINT UNSIGNED NULL,
    respondido_em DATETIME(6) NULL,
    revogado_em DATETIME(6) NULL,
    motivo_revogacao VARCHAR(100) NULL,
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_confirmacoes_clinica_id (clinica_id, id),
    UNIQUE KEY uk_confirmacoes_token_hash (token_hash),
    KEY idx_confirmacoes_consulta (clinica_id, consulta_id, criado_em),
    KEY idx_confirmacoes_pendentes (clinica_id, consulta_id, estado, expira_em),
    CONSTRAINT fk_confirmacoes_consulta
        FOREIGN KEY (clinica_id, consulta_id)
        REFERENCES consultas (clinica_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_confirmacoes_solicitante
        FOREIGN KEY (clinica_id, solicitado_por_usuario_id)
        REFERENCES clinica_usuarios (clinica_id, usuario_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_confirmacoes_resposta_operador
        FOREIGN KEY (clinica_id, respondido_por_usuario_id)
        REFERENCES clinica_usuarios (clinica_id, usuario_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_confirmacoes_token_canal CHECK (
        (canal = 'manual' AND token_hash IS NULL AND expira_em IS NULL)
        OR (canal <> 'manual' AND token_hash IS NOT NULL AND expira_em IS NOT NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS confirmacoes_consulta_eventos (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    clinica_id BIGINT UNSIGNED NOT NULL,
    confirmacao_id BIGINT UNSIGNED NOT NULL,
    evento ENUM('criada', 'confirmada', 'recusada', 'revogada', 'expirada') NOT NULL,
    origem ENUM('operador', 'link_publico', 'sistema') NOT NULL,
    usuario_id BIGINT UNSIGNED NULL,
    metadados JSON NULL,
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    KEY idx_confirmacoes_eventos (clinica_id, confirmacao_id, criado_em),
    CONSTRAINT fk_confirmacoes_eventos_confirmacao
        FOREIGN KEY (clinica_id, confirmacao_id)
        REFERENCES confirmacoes_consulta (clinica_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_confirmacoes_eventos_usuario
        FOREIGN KEY (clinica_id, usuario_id)
        REFERENCES clinica_usuarios (clinica_id, usuario_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
