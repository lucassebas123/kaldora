// src/utils/importador.js
//
// IMPORTADOR UNIVERSAL de bancos de preguntas para el panel admin.
// Acepta texto pegado (de PDF, Word, web…) o archivos: .csv, .tsv, .txt,
// .json, .sql, .md — y acomoda el formato automáticamente:
//
//   * JSON con { letra, pregunta, respuesta } / { pregunta, opciones,
//     indice_correcto|correcta } / { pregunta, es_verdadera }
//   * CSV/TSV (export de Excel/Sheets): detecta delimitador, cabecera y
//     mapea columnas por nombre o posición.
//   * SQL: INSERT INTO ... VALUES (...), (...);
//   * Texto libre: "A | Pregunta | Respuesta", "A - pregunta - respuesta",
//     "A. pregunta: respuesta", frases con V/F al final, trivia con
//     opciones y la correcta al final (texto o número).
//
// Devuelve { items, descartes, formato }. Cada descarte incluye el NÚMERO
// de línea original (n) para poder reportar "Línea 42 ignorada...".
//
// Los archivos grandes se leen POR CHUNKS (Blob.slice + TextDecoder stream):
// nunca se carga el archivo entero en memoria como buffer, y la lectura no
// bloquea la interfaz (equivalente del bufio.Scanner sin backend).

const LETRAS_OK = 'ABCDEFGHIJKLMNÑOPQRSTUVWXYZ';

/** Tope de ingesta: más que esto, pedir dividir en lotes. */
export const MAX_TEXTO = 15 * 1024 * 1024; // 15 MB

function normalizarBooleano(texto) {
  const t = String(texto || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (['v', 'verdadero', 'true', 'si', 'yes', '1', '✓', 'correcto'].includes(t)) return true;
  if (['f', 'falso', 'false', 'no', '0', '✗', 'x', 'incorrecto'].includes(t)) return false;
  return null;
}

function detectarDelimitador(linea) {
  const conteos = [
    ['\t', (linea.match(/\t/g) || []).length],
    ['|', (linea.match(/\|/g) || []).length],
    [';', (linea.match(/;/g) || []).length],
    [',', (linea.match(/,/g) || []).length],
  ];
  conteos.sort((a, b) => b[1] - a[1]);
  return conteos[0][1] > 0 ? conteos[0][0] : null;
}

function partirLinea(linea, delimitador) {
  // Respeta comillas dobles ("pregunta, con coma", otra).
  const campos = [];
  let actual = '';
  let enComillas = false;
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i];
    if (ch === '"') {
      if (enComillas && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else {
        enComillas = !enComillas;
      }
    } else if (ch === delimitador && !enComillas) {
      campos.push(actual.trim());
      actual = '';
    } else {
      actual += ch;
    }
  }
  campos.push(actual.trim());
  return campos;
}

/**
 * Convierte un ítem crudo (campos sueltos) al formato del banco elegido.
 * Regla estricta del Rosco: más de 3 campos = línea inválida (el formato es
 * letra | pregunta | respuesta, no se toleran columnas extra).
 */
function armarItem(banco, campos) {
  if (banco === 'rosco') {
    if (campos.length > 3) return null;
    let [letra, pregunta, respuesta] = campos;
    // Tolerar "A) pregunta" o "A. pregunta" en el primer campo.
    if (pregunta === undefined && respuesta === undefined && letra) {
      const m = letra.match(/^([A-ZÑ])[).:\-–]\s*(.+)$/i);
      if (m) {
        letra = m[1];
        pregunta = m[2];
      }
    }
    // Tolerar "C. País: Capital" (2 campos tras separador débil): el primero
    // trae letra+pregunta y el segundo es la respuesta.
    if (respuesta === undefined && pregunta !== undefined && letra) {
      const m = String(letra).match(/^([A-ZÑ])[).:\-–]\s*(.+)$/i);
      if (m) {
        letra = m[1];
        respuesta = pregunta;
        pregunta = m[2];
      }
    }
    letra = String(letra || '').trim().toUpperCase();
    if (!LETRAS_OK.includes(letra) || letra.length !== 1) return null;
    if (!pregunta?.trim() || !respuesta?.trim()) return null;
    return { letra, pregunta: pregunta.trim(), respuesta: respuesta.trim() };
  }

  if (banco === 'supervivencia') {
    const texto = campos.join(' ');
    // Busca el V/F al final: "… :: V" / "… - F" / "…, verdadero".
    const m = texto.match(/^(.+?)\s*(?:[|;,\-–—=:]|\b)+\s*(v|f|verdadero|falso|true|false|si|no)\s*\.?$/i);
    if (m) {
      const valor = normalizarBooleano(m[2]);
      if (valor !== null && m[1].trim().length > 3) {
        return { pregunta: m[1].trim().replace(/[|;:.\-–—=]+$/, '').trim(), es_verdadera: valor };
      }
    }
    if (campos.length >= 2) {
      const valor = normalizarBooleano(campos[campos.length - 1]);
      if (valor !== null) {
        const pregunta = campos.slice(0, -1).join(' ').trim();
        if (pregunta) return { pregunta, es_verdadera: valor };
      }
    }
    return null;
  }

  // trivia: pregunta | op1 | op2 | [op3] [op4] | correcta (texto o índice)
  if (campos.length >= 3) {
    const pregunta = campos[0];
    const posibles = campos.slice(1);
    const ultima = posibles[posibles.length - 1];
    let opciones = posibles;
    let indice = -1;

    const comoNumero = parseInt(ultima, 10);
    if (Number.isInteger(comoNumero) && String(comoNumero) === ultima.trim()) {
      // Índice 1-based (más natural al escribir) o 0-based si hay un 0.
      indice = comoNumero === 0 ? 0 : comoNumero - 1;
      opciones = posibles.slice(0, -1);
    } else if (/^\(?([a-dA-D])\)?\.?$/.test(ultima.trim())) {
      // Marcador de correcta tipo letra: "b", "B)", "(b)". ANTES del texto:
      // si no, el findIndex de abajo matchea el marcador consigo mismo.
      indice = ultima.trim().toLowerCase().charCodeAt(0) - 97;
      opciones = posibles.slice(0, -1);
    } else {
      indice = posibles.findIndex((o) => o.trim().toLowerCase() === ultima.trim().toLowerCase());
      // La última coincide con una opción: es la correcta y no una opción extra.
      if (indice >= 0 && indice !== posibles.length - 1) {
        opciones = posibles.slice(0, -1);
      } else if (indice === posibles.length - 1) {
        // Última igual a sí misma: ambiguo — tratarla como opción más correcta.
        opciones = posibles;
        indice = opciones.length - 1;
      }
      // Si no matcheó nada, la última columna queda como opción extra y el
      // índice queda -1 → el ítem se descarta más abajo (sin inventar).
    }

    opciones = opciones.map((o) => o.trim()).filter(Boolean);
    if (!pregunta?.trim() || opciones.length < 2 || opciones.length > 4) return null;
    if (indice < 0 || indice >= opciones.length) return null;
    return { pregunta: pregunta.trim(), opciones, indice_correcto: indice };
  }
  return null;
}

/**
 * Filtra opciones vacías RECALCULANDO el índice de la correcta (sin
 * desindexar): la correcta sigue siendo la misma palabra aunque se eliminen
 * opciones vacías antes de ella. Si la marcada estaba vacía → correctaPerdida.
 */
export function consolidarTrivia({ pregunta, opciones, indice_correcto }) {
  const opcionesValidas = [];
  let indiceNuevo = 0;
  let correctaPerdida = false;
  (opciones || []).forEach((o, i) => {
    const t = String(o || '').trim();
    if (!t) {
      if (i === indice_correcto) correctaPerdida = true;
      return;
    }
    if (i === indice_correcto) indiceNuevo = opcionesValidas.length;
    opcionesValidas.push(t);
  });
  return {
    pregunta: String(pregunta || '').trim(),
    opciones: opcionesValidas,
    indice_correcto: indiceNuevo,
    correctaPerdida,
  };
}

function parsearJson(texto) {
  const crudo = JSON.parse(texto);
  const lista = Array.isArray(crudo) ? crudo : crudo.items || crudo.preguntas || [];
  return lista.map((o) => {
    const item = {};
    item.letra = (o.letra ?? o.Letra)?.toString?.().trim?.().toUpperCase?.();
    item.pregunta = o.pregunta ?? o.Pregunta ?? o.question ?? o.frase ?? o.texto;
    item.respuesta = o.respuesta ?? o.Respuesta ?? o.answer ?? o.solucion;
    item.opciones = o.opciones ?? o.opcion ?? o.options ?? o.Opciones;
    item.indice_correcto = o.indice_correcto ?? o.indice ?? o.correct_index;
    const vb = o.es_verdadera ?? o.verdadero ?? o.esVerdadera ?? o.vof ?? o.v_f;
    item.es_verdadera = typeof vb === 'boolean' ? vb : normalizarBooleano(vb);
    const correctaTexto = o.correcta ?? o.correcta_texto ?? o.respuesta_correcta;
    if (item.indice_correcto === undefined && correctaTexto !== undefined && Array.isArray(item.opciones)) {
      const idx = item.opciones.findIndex(
        (op) => String(op).trim().toLowerCase() === String(correctaTexto).trim().toLowerCase()
      );
      if (idx >= 0) item.indice_correcto = idx;
    }
    return item;
  });
}

function parsearSql(texto) {
  // Scanner de tuplas de VALUES: soporta multi-fila, comas y paréntesis
  // DENTRO de comillas, paréntesis anidados y corte en el `;` final.
  const items = [];
  const idx = texto.search(/\bVALUES\b/i);
  if (idx === -1) return items;

  let enComillas = false;
  let profundidad = 0;
  let campo = '';
  let fila = [];

  for (let i = idx + 6; i < texto.length; i++) {
    const ch = texto[i];
    if (enComillas) {
      if (ch === "'") {
        if (texto[i + 1] === "'") {
          campo += "'";
          i++;
        } else {
          enComillas = false;
        }
      } else {
        campo += ch;
      }
      continue;
    }

    switch (ch) {
      case "'":
        enComillas = true;
        break;
      case '(':
        profundidad++;
        if (profundidad === 1) {
          campo = '';
          fila = [];
        } else {
          campo += ch;
        }
        break;
      case ')':
        profundidad--;
        if (profundidad === 0) {
          fila.push(campo.trim());
          campo = '';
          if (fila.some((c) => c !== '')) items.push(fila);
          fila = [];
        } else {
          campo += ch;
        }
        break;
      case ',':
        if (profundidad === 1) {
          fila.push(campo.trim());
          campo = '';
        } else if (profundidad > 1) {
          campo += ch;
        }
        break;
      case ';':
        if (profundidad === 0) return items;
        break;
      default:
        if (profundidad >= 1) campo += ch;
    }
  }
  return items; // filas de campos; el orden depende del INSERT original
}

/**
 * Importa un lote de líneas YA PARTIDAS (para streaming por chunks).
 * @param {string[]} lineas - líneas crudas (sin trailing vacío)
 * @param {string} banco - 'rosco' | 'trivia' | 'supervivencia'
 * @param {{ lineaInicial?: number, vistos?: Set, primera?: boolean, delimitador?: string|null }} estado
 * @returns {{ items: Array, descartes: Array, primeraRestante: boolean }}
 */
export function importarLineas(lineas, banco, estado = {}) {
  const { lineaInicial = 0, vistos = new Set(), primera = true, delimitador: forzado } = estado;
  const items = [];
  const descartes = [];
  let usadaPrimera = primera;
  // El delimitador se detecta UNA vez (como exportan Excel/Sheets) y aplica
  // a todo el lote; si no viene forzado, se detecta por línea.
  let delimitadorLote = forzado === undefined ? undefined : forzado;

  for (let k = 0; k < lineas.length; k++) {
    const n = lineaInicial + k + 1;
    const cruda = String(lineas[k] || '').trim();
    if (!cruda || cruda.startsWith('//') || cruda.startsWith('#')) continue;

    if (delimitadorLote === undefined) delimitadorLote = detectarDelimitador(cruda);
    const delimitadorLinea = delimitadorLote ?? (cruda.match(/ - | – |\. |: /) ? 'regex' : null);
    let campos =
      delimitadorLinea && delimitadorLinea !== 'regex'
        ? partirLinea(cruda, delimitadorLinea)
        : cruda.split(/\s*(?:\s[-–—]\s|\s=\s|:\s|\s\|\s)\s*/).map((s) => s.trim());

    // Lote con delimitador fuerte pero línea que no lo usa (formato mixto:
    // "A | x | y" + "B - x - y" + "C. x: y"): reintenta con separadores débiles.
    if (delimitadorLinea && delimitadorLinea !== 'regex' && campos.length === 1) {
      campos = cruda.split(/\s*(?:\s[-–—]\s|\s=\s|:\s|\s\|\s)\s*/).map((s) => s.trim());
    }

    if (usadaPrimera) {
      usadaPrimera = false;
      // CABECERA estricta: TODOS los campos deben ser nombres de columna
      // (una pregunta real suele contener "pregunta" y no es cabecera).
      const camposLlenos = campos.filter((c) => c.trim() !== '');
      const esCabecera =
        camposLlenos.length >= 2 &&
        camposLlenos.every((c) =>
          /letra|pregunta|respuesta|opciones?|opción|alternativa|indice|index|correcta|verdadero|v\/f|nombre/.test(c.toLowerCase())
        );
      if (esCabecera) continue; // cabecera: se ignora sin descartar
    }

    const limpios = campos.map((c) => String(c ?? '').trim()).filter((c) => c !== '');
    if (limpios.length === 0) continue;

    // Regla estricta del Rosco: reportar el exceso de columnas con precisión.
    if (banco === 'rosco' && limpios.length > 3) {
      descartes.push({
        n,
        linea: limpios.join(' | ').slice(0, 70),
        razon: 'más de 3 columnas (formato: letra | pregunta | respuesta)',
      });
      continue;
    }

    const item = armarItem(banco, limpios);
    if (item) {
      const clave = JSON.stringify([item.pregunta, item.letra, item.opciones]);
      if (!vistos.has(clave)) {
        vistos.add(clave);
        items.push(item);
      }
    } else {
      descartes.push({ n, linea: limpios.join(' | ').slice(0, 70), razon: 'no matchea el formato esperado' });
    }
  }

  return { items, descartes, primeraRestante: usadaPrimera };
}

/**
 * IMPORTADOR UNIVERSAL (API pública, sincrónico).
 * @returns {{ items: Array, descartes: Array<{n?:number, linea:string, razon:string}>, formato: string }}
 */
export function importarBanco(texto, banco) {
  const crudo = texto.trim();
  if (!crudo) return { items: [], descartes: [], formato: 'vacío' };

  let formato = 'texto';

  if (/^[[{]/.test(crudo)) {
    try {
      const itemsJson = parsearJson(crudo);
      formato = 'json';
      const items = [];
      const descartes = [];
      itemsJson.forEach((item, idx) => {
        if (banco === 'rosco') {
          const armado = armarItem('rosco', [item.letra, item.pregunta, item.respuesta]);
          if (armado) items.push(armado);
          else descartes.push({ n: idx + 1, linea: JSON.stringify(item).slice(0, 60), razon: 'falta letra/pregunta/respuesta' });
        } else if (banco === 'trivia') {
          const opciones = Array.isArray(item.opciones) ? item.opciones.map(String) : null;
          const indice = Number(item.indice_correcto);
          if (item.pregunta && opciones && opciones.length >= 2 && Number.isInteger(indice) && indice >= 0 && indice < opciones.length) {
            items.push({ pregunta: String(item.pregunta), opciones, indice_correcto: indice });
          } else {
            descartes.push({ n: idx + 1, linea: JSON.stringify(item).slice(0, 60), razon: 'opciones/índice inválidos' });
          }
        } else {
          if (item.pregunta && typeof item.es_verdadera === 'boolean') {
            items.push({ pregunta: String(item.pregunta), es_verdadera: item.es_verdadera });
          } else {
            descartes.push({ n: idx + 1, linea: JSON.stringify(item).slice(0, 60), razon: 'falta frase o V/F' });
          }
        }
      });
      const vistos = new Set();
      const unicos = items.filter((i) => {
        const clave = JSON.stringify([i.pregunta, i.letra, i.opciones]);
        if (vistos.has(clave)) return false;
        vistos.add(clave);
        return true;
      });
      return { items: unicos, descartes, formato };
    } catch {
      /* no era JSON válido: seguir con texto */
    }
  }

  const items = [];
  const descartes = [];
  const vistos = new Set();

  if (/insert\s+into/i.test(crudo)) {
    formato = 'sql';
    const filasSql = parsearSql(crudo);
    // Heurística: si hay cabecera "insert into tabla (a, b, c)", mapear columnas.
    const mCabecera = crudo.match(/insert\s+into\s+[\w".]+\s*\(([^)]+)\)/i);
    let columnas = null;
    if (mCabecera) {
      columnas = mCabecera[1].split(',').map((c) => c.trim().toLowerCase().replace(/["'`]/g, ''));
    }
    const filas = filasSql.map((campos) => {
      if (!columnas) return campos;
      const porNombre = {};
      columnas.forEach((col, i) => {
        if (/letra/.test(col)) porNombre.letra = campos[i];
        else if (/opc|alternativa/.test(col)) (porNombre.opciones ||= []).push(String(campos[i]).replace(/["'[\]]/g, ''));
        else if (/indice/.test(col)) porNombre.indice = campos[i];
        else if (/correcta/.test(col) && !/indice/.test(col)) porNombre.correcta = campos[i];
        else if (/respuesta/.test(col)) porNombre.respuesta = campos[i];
        else if (/verdadera/.test(col)) porNombre.verdadero = campos[i];
        else if (/pregunta|frase/.test(col)) porNombre.pregunta = campos[i];
      });
      if (porNombre.opciones && porNombre.pregunta !== undefined) {
        const camposOut = [porNombre.pregunta, ...porNombre.opciones];
        if (porNombre.indice !== undefined) camposOut.push(porNombre.indice);
        else if (porNombre.correcta !== undefined) camposOut.push(porNombre.correcta);
        return camposOut;
      }
      // Sin columnas de opciones reconocidas: mapear por banco.
      // Rosco = (letra, pregunta, respuesta) · Supervivencia = (pregunta, V/F).
      if (banco === 'rosco') {
        return [porNombre.letra ?? '', porNombre.pregunta ?? '', porNombre.respuesta ?? ''];
      }
      if (banco === 'supervivencia') {
        return [porNombre.pregunta ?? '', porNombre.verdadero ?? porNombre.respuesta ?? ''];
      }
      return [porNombre.pregunta ?? '', porNombre.correcta ?? porNombre.respuesta ?? ''];
    });

    for (let idx = 0; idx < filas.length; idx++) {
      const limpios = filas[idx].map((c) => String(c ?? '').trim()).filter((c) => c !== '');
      if (limpios.length === 0) continue;
      if (banco === 'rosco' && limpios.length > 3) {
        descartes.push({ n: idx + 1, linea: limpios.join(' | ').slice(0, 70), razon: 'más de 3 columnas (formato: letra | pregunta | respuesta)' });
        continue;
      }
      const item = armarItem(banco, limpios);
      if (item) {
        const clave = JSON.stringify([item.pregunta, item.letra, item.opciones]);
        if (!vistos.has(clave)) {
          vistos.add(clave);
          items.push(item);
        }
      } else {
        descartes.push({ n: idx + 1, linea: limpios.join(' | ').slice(0, 70), razon: 'no matchea el formato esperado' });
      }
    }
    return { items, descartes, formato };
  }

  formato = 'csv/texto';
  return { ...importarLineas(crudo.split(/\r?\n/), banco, { vistos }), formato };
}

// =============================================================================
// INGESTA DE ARCHIVOS POR CHUNKS (análogo del bufio.Scanner en el navegador)
// =============================================================================
// El archivo NUNCA se materializa completo como ArrayBuffer: se lee por
// porciones (Blob.slice), se decodifica en streaming (TextDecoder con
// { stream: true }) y se cede el hilo entre chunks. La memoria queda acotada
// al texto resultante, y se aplica un tope duro (MAX_TEXTO) para rechazar
// archivos absurdos antes de empezar.

const CHUNK = 4 * 1024 * 1024; // 4 MB por porción

/**
 * Lee un archivo de texto por chunks sin bloquear la UI.
 * @param {File} archivo
 * @param {(progreso: number) => void} [alProgreso] - progreso 0..1
 * @returns {Promise<string>}
 */
export async function leerArchivoPorChunks(archivo, alProgreso) {
  if (archivo.size > MAX_TEXTO) {
    throw new Error(
      `El archivo pesa ${(archivo.size / 1048576).toFixed(1)} MB y el máximo es ${
        MAX_TEXTO / 1048576
      } MB. Dividilo en varios lotes.`
    );
  }
  const decodificador = new TextDecoder('utf-8');
  let texto = '';
  let desde = 0;
  while (desde < archivo.size) {
    const porcion = await archivo.slice(desde, desde + CHUNK).arrayBuffer();
    texto += decodificador.decode(porcion, { stream: true });
    desde += CHUNK;
    alProgreso?.(Math.min(1, desde / archivo.size));
    // Cede el hilo: la interfaz respira entre chunks.
    await new Promise((r) => setTimeout(r, 0));
  }
  texto += decodificador.decode(); // flush del decodificador
  alProgreso?.(1);
  return texto;
}
