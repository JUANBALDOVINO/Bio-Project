// Copia los datos actuales de MySQL/XAMPP a Supabase/PostgreSQL.
// No elimina registros del destino: los inserta o actualiza por clave primaria.
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const fs = require('fs');
const mysql = require('mysql2/promise');
const { Client } = require('pg');

const tables = {
  equipos: ['id_equipo', 'nombre_equipo', 'marca', 'modelo', 'numero_serie', 'nivel_riesgo', 'ubicacion', 'estado', 'tipo_categoria', 'fecha_compra', 'horas_uso', 'foto_equipo', 'hist_mto_preventivo', 'fecha_mto_preventivo', 'hist_mto_correctivo', 'fecha_mto_correctivo', 'proximo_mto_preventivo'],
  usuarios: ['id_usuario', 'nombre', 'correo', 'password', 'rol', 'creado_en'],
  mantenimientos: ['id_mantenimiento', 'id_equipo', 'tipo', 'fecha', 'detalle', 'id_usuario', 'creado_en'],
  notificaciones_mantenimiento: ['id_notificacion', 'id_equipo', 'fecha_programada', 'estado_alerta', 'enviado_en'],
  notificaciones_mantenimiento_destinatarios: ['id_envio', 'id_equipo', 'fecha_programada', 'estado_alerta', 'correo_destinatario', 'enviado_en']
};
const keys = { equipos: 'id_equipo', usuarios: 'id_usuario', mantenimientos: 'id_mantenimiento', notificaciones_mantenimiento: 'id_notificacion', notificaciones_mantenimiento_destinatarios: 'id_envio' };

async function main() {
  if (!process.env.SUPABASE_DATABASE_URL) throw new Error('Falta SUPABASE_DATABASE_URL en .env');
  const source = await mysql.createConnection({ host: process.env.MYSQL_HOST || '127.0.0.1', port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER || 'root', password: process.env.MYSQL_PASSWORD || '', database: process.env.MYSQL_DATABASE || 'biomant', dateStrings: true });
  const destination = new Client({ connectionString: process.env.SUPABASE_DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  try {
    await destination.connect();
    const schema = fs.readFileSync(path.resolve(__dirname, '../database/migrations/supabase_schema.sql'), 'utf8');
    await destination.query(schema);
    await destination.query('BEGIN');
    for (const [table, columns] of Object.entries(tables)) {
      const [rows] = await source.query(`SELECT ${columns.map(c => `\`${c}\``).join(', ')} FROM \`${table}\``);
      for (const row of rows) {
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
        const updateCols = columns.filter(c => c !== keys[table]).map(c => `${c} = EXCLUDED.${c}`).join(', ');
        const conflict = updateCols ? `DO UPDATE SET ${updateCols}` : 'DO NOTHING';
        await destination.query(`INSERT INTO public.${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (${keys[table]}) ${conflict}`, columns.map(c => row[c]));
      }
      console.log(`${table}: ${rows.length} registros copiados`);
    }
    for (const table of ['usuarios', 'mantenimientos', 'notificaciones_mantenimiento', 'notificaciones_mantenimiento_destinatarios']) {
      const column = keys[table];
      await destination.query(`SELECT setval(pg_get_serial_sequence('public.${table}', '${column}'), COALESCE((SELECT MAX(${column}) FROM public.${table}), 1), EXISTS (SELECT 1 FROM public.${table}))`);
    }
    await destination.query('COMMIT');
    console.log('Migración completada.');
  } catch (error) {
    try { await destination.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    await source.end();
    await destination.end().catch(() => {});
  }
}

main().catch(error => {
  console.error(`Migración no completada: ${error.code || error.message}`);
  process.exitCode = 1;
});
