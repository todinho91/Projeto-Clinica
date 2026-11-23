CREATE TABLE IF NOT EXISTS consultorio_delegacoes (
    clinica_id BIGINT UNSIGNED NOT NULL,
    clinica_usuario_id BIGINT UNSIGNED NOT NULL,
    gerenciar_disponibilidade TINYINT(1) NOT NULL DEFAULT 0,
    atualizado_por_usuario_id BIGINT UNSIGNED NOT NULL,
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    atualizado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
        ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (clinica_id, clinica_usuario_id),
    CONSTRAINT chk_consultorio_delegacoes_disponibilidade
        CHECK (gerenciar_disponibilidade IN (0, 1)),
    CONSTRAINT fk_consultorio_delegacoes_consultorio
        FOREIGN KEY (clinica_id) REFERENCES consultorios_profissionais (clinica_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_consultorio_delegacoes_vinculo
        FOREIGN KEY (clinica_id, clinica_usuario_id)
        REFERENCES clinica_usuarios (clinica_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_consultorio_delegacoes_operador
        FOREIGN KEY (atualizado_por_usuario_id) REFERENCES usuarios (id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
