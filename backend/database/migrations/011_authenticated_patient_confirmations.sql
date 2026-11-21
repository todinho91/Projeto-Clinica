-- M4-04: distingue a resposta autenticada no portal Vitalis de aplicativo/push.
-- Esta migration e aditiva e nao deve ser executada automaticamente.

ALTER TABLE pacientes
    ADD COLUMN confirmacao_vitalis_ativa TINYINT(1) NOT NULL DEFAULT 0
        AFTER preferencia_contato,
    ADD CONSTRAINT chk_pacientes_confirmacao_vitalis
        CHECK (confirmacao_vitalis_ativa IN (0, 1));

ALTER TABLE confirmacoes_consulta
    DROP CHECK chk_confirmacoes_token_canal;

ALTER TABLE confirmacoes_consulta
    MODIFY canal ENUM('whatsapp', 'portal_vitalis', 'aplicativo', 'push', 'manual') NOT NULL;

ALTER TABLE confirmacoes_consulta
    ADD CONSTRAINT chk_confirmacoes_token_canal CHECK (
        (canal = 'manual' AND token_hash IS NULL AND expira_em IS NULL)
        OR
        (canal = 'portal_vitalis' AND token_hash IS NULL
            AND (estado <> 'preparada' OR expira_em IS NOT NULL))
        OR
        (canal NOT IN ('manual', 'portal_vitalis') AND token_hash IS NOT NULL AND expira_em IS NOT NULL)
    );

ALTER TABLE confirmacoes_consulta_eventos
    MODIFY origem ENUM('operador', 'paciente_autenticado', 'link_publico', 'sistema') NOT NULL;
