-- BioMant: permite registrar cada recordatorio preventivo según los días
-- respecto de la fecha programada. Conserva y clasifica los envíos existentes.

ALTER TABLE public.notificaciones_mantenimiento_destinatarios
  ADD COLUMN IF NOT EXISTS dias_alerta integer;

UPDATE public.notificaciones_mantenimiento_destinatarios
SET dias_alerta = fecha_programada - (enviado_en AT TIME ZONE 'America/Bogota')::date
WHERE dias_alerta IS NULL;

ALTER TABLE public.notificaciones_mantenimiento_destinatarios
  ALTER COLUMN dias_alerta SET DEFAULT 0;

ALTER TABLE public.notificaciones_mantenimiento_destinatarios
  ALTER COLUMN dias_alerta SET NOT NULL;

ALTER TABLE public.notificaciones_mantenimiento_destinatarios
  DROP CONSTRAINT IF EXISTS notificaciones_mantenimiento_destinatarios_id_equipo_fecha_programada_estado_alerta_correo_destinatario_key;

ALTER TABLE public.notificaciones_mantenimiento_destinatarios
  DROP CONSTRAINT IF EXISTS notificaciones_mantenimiento_destinatarios_id_equipo_fecha_programada_estado_alerta_dias_alerta_correo_destinatario_key;

ALTER TABLE public.notificaciones_mantenimiento_destinatarios
  DROP CONSTRAINT IF EXISTS notificaciones_mantenimiento__id_equipo_fecha_programada_es_key;

ALTER TABLE public.notificaciones_mantenimiento_destinatarios
  DROP CONSTRAINT IF EXISTS notificaciones_mantenimiento__id_equipo_fecha_programada_es_dias_alerta_correo_destinatario_key;

ALTER TABLE public.notificaciones_mantenimiento_destinatarios
  DROP CONSTRAINT IF EXISTS uq_alerta_equipo_destinatario;

DROP INDEX IF EXISTS public.uq_alerta_equipo_destinatario;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_alerta_equipo_etapa_destinatario'
      AND conrelid = 'public.notificaciones_mantenimiento_destinatarios'::regclass
  ) THEN
    ALTER TABLE public.notificaciones_mantenimiento_destinatarios
      ADD CONSTRAINT uq_alerta_equipo_etapa_destinatario
      UNIQUE (id_equipo, fecha_programada, estado_alerta, dias_alerta, correo_destinatario);
  END IF;
END
$$;
