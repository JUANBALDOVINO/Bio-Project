const { Pool } = require('pg');

if (!process.env.SUPABASE_DATABASE_URL) {
  throw new Error('Falta SUPABASE_DATABASE_URL en el archivo .env.');
}

const pool = new Pool({
  connectionString: process.env.SUPABASE_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

const ID_COLUMNS = {
  usuarios: 'id_usuario',
  mantenimientos: 'id_mantenimiento',
  notificaciones_mantenimiento: 'id_notificacion',
  notificaciones_mantenimiento_destinatarios: 'id_envio',
  reprogramaciones_mantenimiento_preventivo: 'id_reprogramacion',
  proveedores_externos: 'id_proveedor',
  ordenes_trabajo_externas: 'id_orden',
  reportes_tecnovigilancia: 'id_reporte',
  tecnovigilancia_auditoria: 'id_evento',
  auditoria_eventos: 'id_evento'
};

function prepararConsulta(sql, valores) {
  let texto = String(sql).trim().replace(/;\s*$/, '');
  let parametros = Array.isArray(valores) ? valores.slice() : [];
  const ignorarConflictos = /^INSERT\s+IGNORE\b/i.test(texto);
  texto = texto.replace(/^INSERT\s+IGNORE\b/i, 'INSERT');

  // mysql2 accepts VALUES ? for a batch; PostgreSQL needs explicit placeholders.
  if (/\bVALUES\s+\?/i.test(texto) && Array.isArray(parametros[0])) {
    const filas = parametros.shift();
    if (!filas.length) throw new Error('No hay filas para insertar.');
    const ancho = filas[0].length;
    const valoresPlano = filas.flat();
    let indice = 0;
    const grupos = filas.map((fila) => {
      if (fila.length !== ancho) throw new Error('Las filas del lote no tienen el mismo número de campos.');
      return `(${fila.map(() => `$${++indice}`).join(', ')})`;
    });
    parametros = valoresPlano;
    texto = texto.replace(/\bVALUES\s+\?/i, `VALUES ${grupos.join(', ')}`);
  } else {
    // mysql2 accepts arrays in IN (?); expand them along with ordinary placeholders.
    const expandidos = [];
    let indiceParametro = 0;
    texto = texto.replace(/\bIN\s*\(\s*\?\s*\)|\?/gi, (coincidencia) => {
      const esListaIn = /^IN\b/i.test(coincidencia);
      const valor = parametros[indiceParametro++];
      if (esListaIn && Array.isArray(valor)) {
        if (!valor.length) return 'IN (NULL)';
        const inicio = expandidos.length;
        expandidos.push(...valor);
        return `IN (${valor.map((_, i) => `$${inicio + i + 1}`).join(', ')})`;
      }
      if (Array.isArray(valor)) {
        if (!valor.length) return 'NULL';
        const inicio = expandidos.length;
        expandidos.push(...valor);
        return valor.map((_, i) => `$${inicio + i + 1}`).join(', ');
      }
      expandidos.push(valor);
      return `$${expandidos.length}`;
    });
    parametros = expandidos;
  }

  texto = texto
    .replace(/DATE_FORMAT\s*\(\s*([^,]+?)\s*,\s*'%Y-%m-%d'\s*\)/gi, "TO_CHAR(($1)::date, 'YYYY-MM-DD')")
    .replace(/DATEDIFF\s*\(\s*([^,]+?)\s*,\s*CURRENT_DATE\s*\)/gi, '(($1)::date - CURRENT_DATE)')
    .replace(/DATE_ADD\s*\(\s*CURRENT_DATE\s*,\s*INTERVAL\s+(\d+)\s+DAY\s*\)/gi, "(CURRENT_DATE + INTERVAL '$1 days')");

  let idColumn = null;
  const insertMatch = texto.match(/^INSERT\s+INTO\s+([a-z_][a-z0-9_]*)/i);
  if (insertMatch && !ignorarConflictos) idColumn = ID_COLUMNS[insertMatch[1].toLowerCase()] || null;
  if (ignorarConflictos) texto += ' ON CONFLICT DO NOTHING';
  else if (idColumn && !/\bRETURNING\b/i.test(texto)) texto += ` RETURNING ${idColumn}`;

  return { texto, parametros, idColumn };
}

async function ejecutarEn(conexion, sql, valores) {
  const preparado = prepararConsulta(sql, valores);
  const resultado = await conexion.query(preparado.texto, preparado.parametros);
  if (/^\s*(SELECT|WITH)\b/i.test(preparado.texto)) return resultado.rows;
  return {
    affectedRows: resultado.rowCount || 0,
    insertId: preparado.idColumn && resultado.rows[0] ? resultado.rows[0][preparado.idColumn] : undefined,
    rowCount: resultado.rowCount || 0
  };
}

function ejecutar(sql, valores) {
  return ejecutarEn(pool, sql, valores);
}

async function ejecutarTransaccion(callback) {
  const conexion = await pool.connect();
  try {
    await conexion.query('BEGIN');
    const transaccion = {
      query(sql, valores = []) {
        return ejecutarEn(conexion, sql, valores);
      }
    };
    const resultado = await callback(transaccion);
    await conexion.query('COMMIT');
    return resultado;
  } catch (error) {
    await conexion.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    conexion.release();
  }
}

const db = {
  query(sql, valores, callback) {
    if (typeof valores === 'function') {
      callback = valores;
      valores = [];
    }
    const solicitud = ejecutar(sql, valores);
    if (typeof callback === 'function') {
      solicitud.then((resultado) => callback(null, resultado)).catch((error) => callback(error));
      return;
    }
    return solicitud;
  },
  promise() {
    return {
      query(sql, valores) {
        return ejecutar(sql, valores).then((resultado) => [resultado, undefined]);
      }
    };
  },
  connect(callback) {
    pool.query('SELECT 1', (error) => callback(error || null));
  },
  transaction: ejecutarTransaccion,
  end() {
    return pool.end();
  }
};

module.exports = db;
