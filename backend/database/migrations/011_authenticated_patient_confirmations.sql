-- M4-04: distingue a resposta autenticada no portal Vitalis de aplicativo/push.
-- Esta migration e aditiva e nao deve ser executada automaticamente.

ALTER TABLE confirmacoes_consulta
    DROP CHECK chk_confirmacoes_token_canal;

ALTER TABLE confirmacoes_consulta
    MODIFY canal ENUM('whatsapp', 'portal_vitalis', 'aplicativo', 'push', 'manual') NOT NULL;

ALTER TABLE confirmacoes_consulta
    ADD CONSTRAINT chk_confirmacoes_token_canal CHECK (
        (canal IN ('manual', 'portal_vitalis') AND token_hash IS NULL AND expira_em IS NULL)
        OR
        (canal NOT IN ('manual', 'portal_vitalis') AND token_hash IS NOT NULL AND expira_em IS NOT NULL)
    );

ALTER TABLE confirmacoes_consulta_eventos
    MODIFY origem ENUM('operador', 'paciente_autenticado', 'link_publico', 'sistema') NOT NULL;
