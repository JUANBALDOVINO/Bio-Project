-- BioMant · Tecnovigilancia · Etapa 4: preparación y seguimiento del reporte Invima
-- Ejecutar después de las migraciones de las etapas 1, 2 y 3.
-- No almacena datos identificables de pacientes ni envía reportes a Invima.

CREATE TABLE IF NOT EXISTS public.tecnovigilancia_reportes_invima (
  id_reporte bigint PRIMARY KEY
    REFERENCES public.reportes_tecnovigilancia(id_reporte) ON DELETE RESTRICT,
  clasificacion_seriedad varchar(16) NOT NULL DEFAULT 'no_aplica'
    CHECK (clasificacion_seriedad IN ('serio', 'no_serio', 'no_aplica')),
  fecha_conocimiento timestamptz,
  estado_envio varchar(16) NOT NULL DEFAULT 'pendiente'
    CHECK (estado_envio IN ('pendiente', 'preparado', 'enviado')),
  fecha_envio timestamptz,
  numero_radicado varchar(100),
  observaciones text NOT NULL DEFAULT '',
  actualizado_por integer REFERENCES public.usuarios(id_usuario) ON DELETE SET NULL,
  actualizado_en timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (numero_radicado IS NULL OR char_length(btrim(numero_radicado)) <= 100),
  CHECK (char_length(observaciones) <= 2000),
  CHECK (estado_envio <> 'enviado' OR fecha_envio IS NOT NULL)
);

ALTER TABLE public.tecnovigilancia_reportes_invima ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.tecnovigilancia_reportes_invima IS
  'Seguimiento administrativo del diligenciamiento y envío manual del reporte a Invima; no representa integración ni radicación automática.';

CREATE INDEX IF NOT EXISTS idx_tecnovigilancia_invima_estado
  ON public.tecnovigilancia_reportes_invima(estado_envio, actualizado_en DESC);
