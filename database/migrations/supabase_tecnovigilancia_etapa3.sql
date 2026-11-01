-- BioMant · Tecnovigilancia · Etapa 3: investigación y análisis de causa
-- Migración aditiva. Ejecutar después de las etapas 1 y 2.

CREATE TABLE IF NOT EXISTS public.tecnovigilancia_investigaciones (
  id_reporte bigint PRIMARY KEY
    REFERENCES public.reportes_tecnovigilancia(id_reporte) ON DELETE RESTRICT,
  estado_investigacion varchar(20) NOT NULL DEFAULT 'pendiente'
    CHECK (estado_investigacion IN ('pendiente', 'en_curso', 'concluida')),
  responsable varchar(120),
  metodologia varchar(20) NOT NULL DEFAULT 'pendiente'
    CHECK (metodologia IN ('pendiente', 'ishikawa', 'modelo_reason', 'otra')),
  causa_clasificacion varchar(24) NOT NULL DEFAULT 'pendiente'
    CHECK (causa_clasificacion IN ('pendiente', 'dispositivo', 'uso_usuario', 'infraestructura', 'fabricante', 'otro', 'indeterminada')),
  analisis_causa text NOT NULL DEFAULT '',
  acciones_correctivas text NOT NULL DEFAULT '',
  acciones_preventivas text NOT NULL DEFAULT '',
  resultado_investigacion text NOT NULL DEFAULT '',
  actualizado_por integer REFERENCES public.usuarios(id_usuario) ON DELETE SET NULL,
  actualizado_en timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (responsable IS NULL OR char_length(btrim(responsable)) <= 120),
  CHECK (char_length(analisis_causa) <= 5000),
  CHECK (char_length(acciones_correctivas) <= 5000),
  CHECK (char_length(acciones_preventivas) <= 5000),
  CHECK (char_length(resultado_investigacion) <= 5000)
);

ALTER TABLE public.tecnovigilancia_investigaciones ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.tecnovigilancia_investigaciones IS
  'Información vigente de la investigación de cada reporte de tecnovigilancia. Los cambios se trazan en tecnovigilancia_auditoria.';

CREATE INDEX IF NOT EXISTS idx_tecnovigilancia_investigaciones_estado
  ON public.tecnovigilancia_investigaciones(estado_investigacion, actualizado_en DESC);
