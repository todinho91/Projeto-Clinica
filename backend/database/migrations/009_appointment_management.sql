ALTER TABLE consultas
    DROP INDEX uk_consultas_inicio_profissional,
    ADD COLUMN especialidade_id BIGINT UNSIGNED NULL AFTER profissional_id,
    ADD COLUMN versao INT UNSIGNED NOT NULL DEFAULT 1 AFTER status,
    ADD COLUMN reserva_ativa TINYINT
        GENERATED ALWAYS AS (CASE WHEN status IN ('agendada', 'confirmada') THEN 1 ELSE NULL END)
        STORED AFTER versao,
    ADD UNIQUE KEY uk_consultas_reserva_inicio
        (clinica_id, profissional_id, inicio_em, reserva_ativa),
    ADD KEY idx_consultas_profissional_periodo
        (clinica_id, profissional_id, status, inicio_em, fim_em),
    ADD KEY idx_consultas_especialidade_data (clinica_id, especialidade_id, inicio_em),
    ADD CONSTRAINT fk_consultas_especialidade
        FOREIGN KEY (clinica_id, especialidade_id)
        REFERENCES especialidades (clinica_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT;

CREATE TABLE IF NOT EXISTS consultas_historico (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    clinica_id BIGINT UNSIGNED NOT NULL,
    consulta_id BIGINT UNSIGNED NOT NULL,
    versao INT UNSIGNED NOT NULL,
    acao ENUM('agendada', 'status_alterado', 'reagendada', 'cancelada') NOT NULL,
    status_anterior ENUM('agendada', 'confirmada', 'realizada', 'cancelada', 'nao_compareceu') NULL,
    status_novo ENUM('agendada', 'confirmada', 'realizada', 'cancelada', 'nao_compareceu') NOT NULL,
    inicio_anterior DATETIME(6) NULL,
    fim_anterior DATETIME(6) NULL,
    inicio_novo DATETIME(6) NOT NULL,
    fim_novo DATETIME(6) NOT NULL,
    alterado_por_usuario_id BIGINT UNSIGNED NOT NULL,
    metadados JSON NULL,
    criado_em TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (id),
    UNIQUE KEY uk_consultas_historico_versao (clinica_id, consulta_id, versao),
    KEY idx_consultas_historico_data (clinica_id, consulta_id, criado_em),
    CONSTRAINT chk_consultas_historico_periodo CHECK (fim_novo > inicio_novo),
    CONSTRAINT fk_consultas_historico_consulta
        FOREIGN KEY (clinica_id, consulta_id)
        REFERENCES consultas (clinica_id, id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_consultas_historico_operador
        FOREIGN KEY (clinica_id, alterado_por_usuario_id)
        REFERENCES clinica_usuarios (clinica_id, usuario_id)
        ON UPDATE RESTRICT ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
