const fs = require('fs');
const path = require('path');

function pad(n, size = 3) {
    return String(n).padStart(size, '0');
}

function sqlStr(valor) {
    return `'${String(valor).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

function fechaISO(anio, mes, dia) {
    return `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function fechaDesdeOffset(base, dias) {
    const d = new Date(base.getTime() + dias * 86400000);
    return fechaISO(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

const catalogo = [
    { nombre: 'Monitor de signos vitales', marca: 'Philips', modelos: ['IntelliVue MX40', 'IntelliVue MX450', 'IntelliVue X3', 'Efficia CM120'], riesgo: 'Alto', horasDia: 18 },
    { nombre: 'Monitor de signos vitales', marca: 'Mindray', modelos: ['uMEC 10', 'BeneVision N17', 'iMEC 12', 'VS-900'], riesgo: 'Alto', horasDia: 18 },
    { nombre: 'Monitor de signos vitales', marca: 'GE Healthcare', modelos: ['B105', 'B125', 'Carescape B650', 'Dash 4000'], riesgo: 'Alto', horasDia: 16 },
    { nombre: 'Monitor de signos vitales', marca: 'Nihon Kohden', modelos: ['BSM-6000', 'PVM-2701', 'CSM-1901'], riesgo: 'Alto', horasDia: 16 },
    { nombre: 'Ventilador mecánico', marca: 'Dräger', modelos: ['Evita V300', 'Savina 300', 'Evita Infinity V500', 'Oxylog 3000 plus'], riesgo: 'Alto', horasDia: 20 },
    { nombre: 'Ventilador mecánico', marca: 'Hamilton Medical', modelos: ['C1', 'C3', 'G5', 'T1'], riesgo: 'Alto', horasDia: 20 },
    { nombre: 'Ventilador mecánico', marca: 'Medtronic', modelos: ['Puritan Bennett 980', 'Puritan Bennett 840', 'Newport e360'], riesgo: 'Alto', horasDia: 18 },
    { nombre: 'Ventilador mecánico', marca: 'Mindray', modelos: ['SV300', 'SV600', 'SynoVent E5'], riesgo: 'Alto', horasDia: 18 },
    { nombre: 'Bomba de infusión volumétrica', marca: 'B. Braun', modelos: ['Infusomat Space', 'Infusomat compact plus', 'Perfusor Space'], riesgo: 'Alto', horasDia: 14 },
    { nombre: 'Bomba de infusión volumétrica', marca: 'Baxter', modelos: ['Sigma Spectrum', 'Colleague CXE', 'Flo-Gard 6201'], riesgo: 'Alto', horasDia: 14 },
    { nombre: 'Bomba de jeringa', marca: 'Alaris', modelos: ['GH Plus', 'CC Plus', 'PK'], riesgo: 'Alto', horasDia: 12 },
    { nombre: 'Bomba de jeringa', marca: 'Fresenius Kabi', modelos: ['Injectomat Agilia', 'Volumat Agilia', 'Orchestra Base Primea'], riesgo: 'Alto', horasDia: 12 },
    { nombre: 'Bomba de nutrición enteral', marca: 'Covidien', modelos: ['Kangaroo ePump', 'Kangaroo Joey', 'Kangaroo 924'], riesgo: 'Medio', horasDia: 10 },
    { nombre: 'Electrocardiógrafo de 12 derivaciones', marca: 'GE Healthcare', modelos: ['MAC 2000', 'MAC 5500 HD', 'MAC 5'], riesgo: 'Medio', horasDia: 6 },
    { nombre: 'Electrocardiógrafo de 12 derivaciones', marca: 'Schiller', modelos: ['CARDIOVIT AT-102', 'CARDIOVIT AT-10 plus', 'CARDIOVIT CS-200'], riesgo: 'Medio', horasDia: 6 },
    { nombre: 'Electrocardiógrafo de 12 derivaciones', marca: 'Edan', modelos: ['SE-1200 Express', 'SE-301', 'SE-601'], riesgo: 'Medio', horasDia: 5 },
    { nombre: 'Desfibrilador monitor', marca: 'Zoll', modelos: ['R Series', 'X Series', 'M Series CCT'], riesgo: 'Alto', horasDia: 4 },
    { nombre: 'Desfibrilador monitor', marca: 'Philips', modelos: ['HeartStart MRx', 'Efficia DFM100', 'HeartStart XL+'], riesgo: 'Alto', horasDia: 4 },
    { nombre: 'Desfibrilador externo automático (DEA)', marca: 'Physio-Control', modelos: ['LIFEPAK CR2', 'LIFEPAK 1000', 'LIFEPAK 15'], riesgo: 'Alto', horasDia: 1 },
    { nombre: 'Equipo de rayos X fijo', marca: 'Siemens Healthineers', modelos: ['Multix Fusion', 'Ysio Max', 'Mobilett Mira Max'], riesgo: 'Alto', horasDia: 8 },
    { nombre: 'Equipo de rayos X portátil', marca: 'GE Healthcare', modelos: ['Optima XR220amx', 'AMX 4+', 'Brivo XR115'], riesgo: 'Alto', horasDia: 6 },
    { nombre: 'Equipo de rayos X portátil', marca: 'Canon Medical', modelos: ['CXDI-710C', 'Radrex-i', 'MobileDaRt Evolution'], riesgo: 'Alto', horasDia: 6 },
    { nombre: 'Arco en C quirúrgico', marca: 'Siemens Healthineers', modelos: ['Cios Select', 'Cios Fusion', 'Arcadis Orbic'], riesgo: 'Alto', horasDia: 5 },
    { nombre: 'Ecógrafo / ultrasonido', marca: 'Mindray', modelos: ['DC-70', 'M9', 'TE7', 'DP-50'], riesgo: 'Medio', horasDia: 8 },
    { nombre: 'Ecógrafo / ultrasonido', marca: 'GE Healthcare', modelos: ['LOGIQ V2', 'Vivid T8', 'Venue Go'], riesgo: 'Medio', horasDia: 8 },
    { nombre: 'Ecógrafo / ultrasonido', marca: 'Philips', modelos: ['Affiniti 70', 'CX50', 'Lumify'], riesgo: 'Medio', horasDia: 7 },
    { nombre: 'Incubadora neonatal', marca: 'Dräger', modelos: ['Isolette 8000 plus', 'Caleo', 'Babytherm 8000'], riesgo: 'Alto', horasDia: 24 },
    { nombre: 'Incubadora neonatal', marca: 'GE Healthcare', modelos: ['Giraffe OmniBed', 'Giraffe Incubator', 'Panda iRes'], riesgo: 'Alto', horasDia: 24 },
    { nombre: 'Cuna de calor radiante', marca: 'Dräger', modelos: ['Resuscitaire', 'Babytherm 8010', 'IW 930'], riesgo: 'Alto', horasDia: 16 },
    { nombre: 'Equipo de fototerapia neonatal', marca: 'Atom Medical', modelos: ['Bili-Therapy Spot', 'NeoBlue LED', 'BiliBlanket Plus'], riesgo: 'Medio', horasDia: 12 },
    { nombre: 'Máquina de anestesia', marca: 'Dräger', modelos: ['Perseus A500', 'Fabius plus', 'Apollo'], riesgo: 'Alto', horasDia: 8 },
    { nombre: 'Máquina de anestesia', marca: 'GE Healthcare', modelos: ['Aisys CS2', 'Avance CS2', 'Carestation 650'], riesgo: 'Alto', horasDia: 8 },
    { nombre: 'Capnógrafo / monitor de CO2', marca: 'Medtronic', modelos: ['Capnostream 35', 'Microcap Plus', 'Capnostream 20p'], riesgo: 'Medio', horasDia: 10 },
    { nombre: 'Oxímetro de pulso', marca: 'Masimo', modelos: ['Radical-7', 'Rad-97', 'MightySat'], riesgo: 'Medio', horasDia: 12 },
    { nombre: 'Oxímetro de pulso', marca: 'Nonin', modelos: ['PalmSat 2500', '7500', 'Onyx Vantage 9590'], riesgo: 'Bajo', horasDia: 8 },
    { nombre: 'Concentrador de oxígeno', marca: 'Philips Respironics', modelos: ['EverFlo', 'SimplyGo', 'Millennium M10'], riesgo: 'Medio', horasDia: 16 },
    { nombre: 'CPAP / BiPAP', marca: 'ResMed', modelos: ['AirSense 10', 'Astral 150', 'Stellar 150'], riesgo: 'Alto', horasDia: 10 },
    { nombre: 'Aspirador quirúrgico', marca: 'Medela', modelos: ['Dominant Flex', 'Basic 30', 'Vario 18'], riesgo: 'Medio', horasDia: 6 },
    { nombre: 'Aspirador de secreciones', marca: 'Laerdal', modelos: ['LCSU 4', 'Serres', 'Suction Unit 300'], riesgo: 'Medio', horasDia: 4 },
    { nombre: 'Electrobisturí / electrocauterio', marca: 'Medtronic', modelos: ['ForceTriad', 'Valleylab FT10', 'LigaSure'], riesgo: 'Alto', horasDia: 6 },
    { nombre: 'Electrobisturí', marca: 'Erbe', modelos: ['VIO 300 D', 'VIO 200 S', 'ICC 350'], riesgo: 'Alto', horasDia: 6 },
    { nombre: 'Lámpara quirúrgica', marca: 'Steris', modelos: ['HarmonyAIR', 'HarmonyLED', 'Berchtold Chromophare'], riesgo: 'Medio', horasDia: 8 },
    { nombre: 'Mesa quirúrgica', marca: 'Maquet', modelos: ['Alphamaquet 1150', 'Magnus', 'Betastar'], riesgo: 'Medio', horasDia: 8 },
    { nombre: 'Autoclave de vapor', marca: 'Tuttnauer', modelos: ['3870EA', '2540MK', 'Elara 11'], riesgo: 'Medio', horasDia: 10 },
    { nombre: 'Autoclave de vapor', marca: 'Getinge', modelos: ['GSS67H', 'HS66', 'Quadro'], riesgo: 'Medio', horasDia: 10 },
    { nombre: 'Esterilizador de peróxido de hidrógeno', marca: 'ASP', modelos: ['STERRAD 100NX', 'STERRAD NX', 'STERRAD 50'], riesgo: 'Alto', horasDia: 8 },
    { nombre: 'Cama eléctrica de UCI', marca: 'Hillrom', modelos: ['Centrella', 'Progressa', 'VersaCare'], riesgo: 'Medio', horasDia: 24 },
    { nombre: 'Cama hospitalaria eléctrica', marca: 'Stryker', modelos: ['InTouch', 'S3', 'Secure II'], riesgo: 'Medio', horasDia: 24 },
    { nombre: 'Monitor fetal', marca: 'Philips', modelos: ['Avalon FM30', 'Avalon FM50', 'Avalon CL'], riesgo: 'Alto', horasDia: 12 },
    { nombre: 'Monitor fetal', marca: 'Edan', modelos: ['F6', 'F9', 'F3'], riesgo: 'Alto', horasDia: 10 },
    { nombre: 'Desfibrilador con marcapasos transcutáneo', marca: 'Zoll', modelos: ['R Series ALS', 'X Series', 'PD 1400'], riesgo: 'Alto', horasDia: 3 },
    { nombre: 'Analizador de gases sanguíneos', marca: 'Radiometer', modelos: ['ABL90 FLEX PLUS', 'ABL800 FLEX', 'ABL80 FLEX'], riesgo: 'Alto', horasDia: 14 },
    { nombre: 'Centrífuga de laboratorio', marca: 'Eppendorf', modelos: ['5702', '5810 R', '5424'], riesgo: 'Medio', horasDia: 6 },
    { nombre: 'Microscopio binocular', marca: 'Olympus', modelos: ['CX23', 'BX43', 'CX33'], riesgo: 'Bajo', horasDia: 6 },
    { nombre: 'Nebulizador ultrasónico', marca: 'Omron', modelos: ['NE-U22', 'NE-C801', 'CompAIR C28P'], riesgo: 'Bajo', horasDia: 4 },
    { nombre: 'Calentador de fluidos', marca: '3M', modelos: ['Ranger 245', 'Bair Hugger 775', 'Ranger 123'], riesgo: 'Medio', horasDia: 6 },
    { nombre: 'Manta de hipotermia / hipertermia', marca: 'Cincinnati Sub-Zero', modelos: ['Blanketrol III', 'Hemotherm', 'Blanketrol II'], riesgo: 'Medio', horasDia: 8 },
    { nombre: 'Máquina de hemodiálisis', marca: 'Fresenius', modelos: ['4008S', '5008S', '6008 CAREsystem'], riesgo: 'Alto', horasDia: 10 },
    { nombre: 'Laringoscopio de video', marca: 'Karl Storz', modelos: ['C-MAC S', 'C-MAC POCKET MONITOR', 'D-BLADE'], riesgo: 'Medio', horasDia: 3 },
    { nombre: 'Endoscopio / torre de videoendoscopía', marca: 'Olympus', modelos: ['EVIS EXERA III', 'CV-190', 'GIF-HQ190'], riesgo: 'Alto', horasDia: 5 },
    { nombre: 'Colposcopio', marca: 'Leisegang', modelos: ['3ML LED', '1E LED', '3MVC'], riesgo: 'Bajo', horasDia: 4 },
    { nombre: 'Báscula hospitalaria de cama', marca: 'Seca', modelos: ['984', '985', '656'], riesgo: 'Bajo', horasDia: 2 },
    { nombre: 'Tensiómetro clínico digital', marca: 'Welch Allyn', modelos: ['Connex Spot Monitor', 'ProBP 3400', 'Vital Signs 6000'], riesgo: 'Bajo', horasDia: 8 },
    { nombre: 'Holter de 24 horas', marca: 'GE Healthcare', modelos: ['SEER 1000', 'SEER Light', 'MARS'], riesgo: 'Medio', horasDia: 24 },
    { nombre: 'Desfibrilador pediátrico', marca: 'Zoll', modelos: ['Ped-Padz II', 'AED Plus Pedi-padz', 'R Series Pedi-padz'], riesgo: 'Alto', horasDia: 2 },
    { nombre: 'Humidificador de alto flujo', marca: 'Fisher & Paykel', modelos: ['Airvo 2', 'Optiflow', 'MR850'], riesgo: 'Medio', horasDia: 16 },
    { nombre: 'Flujómetro de oxígeno', marca: 'Precision Medical', modelos: ['PM1000', 'Easy Dial', 'Chrome Flowmeter'], riesgo: 'Bajo', horasDia: 12 },
    { nombre: 'Monitor de capnografía sidestream', marca: 'Oridion', modelos: ['Microcap', 'Capnostream 20', 'Microstream'], riesgo: 'Medio', horasDia: 10 },
    { nombre: 'Equipo de mamografía digital', marca: 'Hologic', modelos: ['Selenia Dimensions', '3Dimensions', 'Fluoroscan InSight'], riesgo: 'Alto', horasDia: 6 },
    { nombre: 'Desfibrilador bifásico de transporte', marca: 'Schiller', modelos: ['DEFIGARD Touch 7', 'FRED easyport', 'DEFIGARD 4000'], riesgo: 'Alto', horasDia: 3 }
];

const ubicaciones = [
    'UCI Adultos',
    'UCI Neonatal',
    'Urgencias',
    'Sala de reanimación',
    'Quirófano 1',
    'Quirófano 2',
    'Quirófano 3',
    'Recuperación postanestésica (PACU)',
    'Neonatología',
    'Pediatría',
    'Gineco-obstetricia',
    'Hospitalización 2do piso',
    'Hospitalización 3er piso',
    'Radiología e imagen',
    'Laboratorio clínico',
    'Consulta externa',
    'Central de esterilización',
    'Sala de procedimientos',
    'Unidad de diálisis',
    'Rehabilitación cardiopulmonar'
];

const estadosPool = [
    ...Array(22).fill('Operativo'),
    ...Array(4).fill('En mantenimiento'),
    ...Array(2).fill('Fuera de servicio'),
    ...Array(2).fill('En calibración')
];

function tecnico(i) {
    const nombres = ['Ing. Laura Mejía', 'Ing. Carolina Ríos', 'Téc. Biomédico Diego Soto'];
    return nombres[i % nombres.length];
}

function histPreventivo(eq, fecha, i) {
    const tareas = [
        `Inspección visual, prueba de alarmas y verificación de fugas. Realizado por ${tecnico(i)}.`,
        `Limpieza de filtros, chequeo de cables/sensores y prueba funcional completa. Realizado por ${tecnico(i + 1)}.`,
        `Verificación de seguridad eléctrica (fuga de corriente) y actualización de bitácora CMMS. Realizado por ${tecnico(i + 2)}.`,
        `Calibración de parámetros clínicos y reemplazo preventivo de consumibles. Realizado por ${tecnico(i + 3)}.`,
        `Prueba de batería, revisión de ruedas/frenos y etiquetado de próximo servicio. Realizado por ${tecnico(i)}.`
    ];
    return `Mantenimiento preventivo del ${fecha}. ${tareas[i % tareas.length]} Hallazgo: equipo dentro de especificaciones del fabricante ${eq.marca}.`;
}

function histCorrectivo(eq, fecha, i, tieneCorrectivo) {
    if (!tieneCorrectivo) {
        return `Sin intervenciones correctivas recientes. Última revisión documentada el ${fecha}: funcionamiento normal.`;
    }
    const fallas = [
        `Cambio de batería interna por autonomía insuficiente.`,
        `Reparación de conector de SpO2 y reemplazo de sensor dañado.`,
        `Ajuste de válvula / circuito neumático por alarma de presión.`,
        `Reemplazo de fusible y fuente de alimentación menor.`,
        `Recalibración tras deriva de medición y prueba con simulador.`,
        `Cambio de rueda trabada y tornillería de carcasa.`,
        `Actualización de firmware y reinicio de configuración clínica.`
    ];
    return `Mantenimiento correctivo del ${fecha}. ${fallas[i % fallas.length]} Cerrado por ${tecnico(i + 2)}. Equipo ${eq.nombre} ${eq.marca} liberado a servicio.`;
}

const filas = [];
const usadosSerie = new Set();

for (let n = 1; n <= 300; n++) {
    const tipo = catalogo[(n - 1) % catalogo.length];
    const modelo = tipo.modelos[(n - 1) % tipo.modelos.length];
    const id = `BIO-${pad(n)}`;
    let serie = `SN-CLR-${tipo.marca.replace(/[^A-Z]/gi, '').slice(0, 4).toUpperCase()}-${2020 + (n % 6)}-${pad(n, 4)}`;
    while (usadosSerie.has(serie)) {
        serie += 'A';
    }
    usadosSerie.add(serie);

    const anioCompra = 2018 + (n % 8);
    const mesCompra = 1 + (n % 12);
    const diaCompra = 1 + (n % 27);
    const fechaCompra = fechaISO(anioCompra, mesCompra, diaCompra);
    const compraDate = new Date(`${fechaCompra}T00:00:00`);
    const hoy = new Date('2026-09-30T00:00:00');
    const diasUso = Math.max(30, Math.floor((hoy - compraDate) / 86400000));
    const factor = 0.55 + ((n * 7) % 40) / 100;
    const horasUso = Math.round(diasUso * tipo.horasDia * factor * 0.35);

    const ubicacion = ubicaciones[(n + tipo.nombre.length) % ubicaciones.length];
    const estado = estadosPool[n % estadosPool.length];
    const foto = `/uploads/equipos/${id}.jpg`;

    const fechaPrev = fechaDesdeOffset(hoy, -((30 + (n * 11) % 150)));
    const tieneCorrectivo = n % 5 === 0 || estado === 'En mantenimiento' || estado === 'Fuera de servicio';
    const fechaCorr = tieneCorrectivo
        ? fechaDesdeOffset(hoy, -((7 + (n * 5) % 90)))
        : fechaPrev;

    filas.push({
        id_equipo: id,
        nombre_equipo: tipo.nombre,
        marca: tipo.marca,
        modelo,
        numero_serie: serie,
        nivel_riesgo: tipo.riesgo,
        ubicacion,
        estado,
        tipo_categoria: 'Biomédico',
        fecha_compra: fechaCompra,
        horas_uso: horasUso,
        foto_equipo: foto,
        hist_mto_preventivo: histPreventivo(tipo, fechaPrev, n),
        fecha_mto_preventivo: fechaPrev,
        hist_mto_correctivo: histCorrectivo(tipo, fechaCorr, n, tieneCorrectivo),
        fecha_mto_correctivo: fechaCorr
    });
}

const header = `-- =============================================================================
-- BioMant / Clínica de los Ríos
-- Población de inventario biomédico (~300 equipos) para phpMyAdmin
-- Base de datos: biomant  |  Tabla: equipos
-- Codificación: utf8mb4
--
-- INSTRUCCIONES:
-- 1. Abrir phpMyAdmin y seleccionar la base de datos biomant.
-- 2. Ir a la pestaña SQL y pegar este archivo completo (o Importar).
-- 3. Ejecutar. El script agrega columnas nuevas si no existen, vacía la tabla
--    equipos y carga 300 registros realistas de ingeniería biomédica.
--
-- ADVERTENCIA: TRUNCATE elimina el inventario actual de la tabla equipos.
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
USE biomant;

-- Columnas adicionales de trazabilidad (compatibles con MariaDB / MySQL 8)
ALTER TABLE equipos ADD COLUMN IF NOT EXISTS fecha_compra DATE NULL COMMENT 'Fecha de adquisición del equipo';
ALTER TABLE equipos ADD COLUMN IF NOT EXISTS horas_uso INT NULL DEFAULT 0 COMMENT 'Horas de uso estimadas';
ALTER TABLE equipos ADD COLUMN IF NOT EXISTS foto_equipo VARCHAR(255) NULL COMMENT 'Ruta o URL de la fotografía';
ALTER TABLE equipos ADD COLUMN IF NOT EXISTS hist_mto_preventivo TEXT NULL COMMENT 'Historial del último mantenimiento preventivo';
ALTER TABLE equipos ADD COLUMN IF NOT EXISTS fecha_mto_preventivo DATE NULL COMMENT 'Fecha del último preventivo';
ALTER TABLE equipos ADD COLUMN IF NOT EXISTS hist_mto_correctivo TEXT NULL COMMENT 'Historial del último mantenimiento correctivo';
ALTER TABLE equipos ADD COLUMN IF NOT EXISTS fecha_mto_correctivo DATE NULL COMMENT 'Fecha del último correctivo';
ALTER TABLE equipos ADD COLUMN IF NOT EXISTS proximo_mto_preventivo DATE NULL COMMENT 'Fecha programada del próximo mantenimiento preventivo';

TRUNCATE TABLE equipos;

INSERT INTO equipos (
    id_equipo,
    nombre_equipo,
    marca,
    modelo,
    numero_serie,
    nivel_riesgo,
    ubicacion,
    estado,
    tipo_categoria,
    fecha_compra,
    horas_uso,
    foto_equipo,
    hist_mto_preventivo,
    fecha_mto_preventivo,
    hist_mto_correctivo,
    fecha_mto_correctivo
) VALUES
`;

const values = filas.map((f, idx) => {
    const linea = `(${[
        sqlStr(f.id_equipo),
        sqlStr(f.nombre_equipo),
        sqlStr(f.marca),
        sqlStr(f.modelo),
        sqlStr(f.numero_serie),
        sqlStr(f.nivel_riesgo),
        sqlStr(f.ubicacion),
        sqlStr(f.estado),
        sqlStr(f.tipo_categoria),
        sqlStr(f.fecha_compra),
        f.horas_uso,
        sqlStr(f.foto_equipo),
        sqlStr(f.hist_mto_preventivo),
        sqlStr(f.fecha_mto_preventivo),
        sqlStr(f.hist_mto_correctivo),
        sqlStr(f.fecha_mto_correctivo)
    ].join(', ')})`;
    return linea + (idx === filas.length - 1 ? ';' : ',');
}).join('\n');

const footer = `

SET FOREIGN_KEY_CHECKS = 1;

-- Verificación rápida
SELECT COUNT(*) AS total_equipos FROM equipos;
SELECT estado, COUNT(*) AS cantidad FROM equipos GROUP BY estado;
SELECT nombre_equipo, COUNT(*) AS cantidad FROM equipos GROUP BY nombre_equipo ORDER BY cantidad DESC;
`;

const carpetaSemillas = path.resolve(__dirname, '../database/seeds');
fs.mkdirSync(carpetaSemillas, { recursive: true });
fs.writeFileSync(
    path.join(carpetaSemillas, 'biomant_inventario_300_equipos.sql'),
    header + values + footer,
    'utf8'
);

console.log(`Generados ${filas.length} INSERTS`);
;
