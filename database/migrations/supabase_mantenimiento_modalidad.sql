-- BioMant · Modalidad del servicio de mantenimiento y vínculo con la programación preventiva
-- Migración aditiva para Supabase/PostgreSQL. No modifica ni elimina registros existentes.

ALTER TABLE public.mantenimientos
  ADD COLUMN IF NOT EXISTS modalidad_servicio varchar(16) NOT NULL DEFAULT 'Interno',
  ADD COLUMN IF NOT EXISTS empresa_contratista varchar(160),
  ADD COLUMN IF NOT EXISTS tecnico_contratista varchar(120),
  ADD COLUMN IF NOT EXISTS orden_servicio varchar(80),
  ADD COLUMN IF NOT EXISTS fecha_programada_atendida date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mantenimientos_modalidad_servicio_check'
      AND conrelid = 'public.mantenimientos'::regclass
  ) THEN
    ALTER TABLE public.mantenimientos
      ADD CONSTRAINT mantenimientos_modalidad_servicio_check
      CHECK (modalidad_servicio IN ('Interno', 'Externo'));
  END IF;
END $$;

COMMENT ON COLUMN public.mantenimientos.modalidad_servicio IS 'Indica si la intervención fue realizada por personal interno o por un contratista externo.';
COMMENT ON COLUMN public.mantenimientos.fecha_programada_atendida IS 'Fecha preventiva programada que se atendió con este registro, si aplica.';
