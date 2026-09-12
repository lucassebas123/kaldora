// src/pages/admin/BancoPreguntas.jsx
//
// GESTIÓN COMPLETA DE BANCOS DE PREGUNTAS (rosco / trivia / supervivencia):
//   * Listado con edición en línea (crear, modificar, eliminar).
//   * IMPORTADOR UNIVERSAL: pegar texto (de PDF/Word/web) o subir archivos
//     .csv / .tsv (Excel/Sheets) / .json / .sql / .txt — detecta delimitador,
//     cabeceras y acomoda las columnas automáticamente. Previsualiza antes
//     de cargar.

import React, { useCallback, useEffect, useState } from 'react';
import {
  Loader2, X, Save, Trash2, Upload, FileText, AlertTriangle, CheckCircle2,
} from 'lucide-react';
import { api, consultas } from '../../api/kaldoraApi';
import { importarBanco, consolidarTrivia, leerArchivoPorChunks } from '../../utils/importador';

const BANCOS = [
  { id: 'rosco', nombre: 'El Rosco', detalle: 'Letra · Pregunta · Respuesta' },
  { id: 'trivia', nombre: 'Trivia', detalle: 'Pregunta · 2-4 opciones · la correcta' },
  { id: 'supervivencia', nombre: 'Supervivencia', detalle: 'Frase · Verdadero o Falso' },
];

const EJEMPLOS = {
  rosco: 'A | Capital de Francia | París\nB - Animal que da leche - Vaca\nC. País de Bogotá: Colombia',
  trivia: '¿Río más largo? | Nilo | Amazonas | Yangtsé | Amazonas\n¿Cuánto es 12x12? | 124 | 132 | 144 | 3',
  supervivencia: 'Los pingüinos viven en el Ártico | F\nEl monte Everest es la montaña más alta | Verdadero',
};

// Listado del banco activo (una sola definición para la carga inicial y los
// recargues posteriores al importar).
async function listarBanco(banco) {
  if (banco === 'rosco') return consultas.listarBancoRosco();
  if (banco === 'trivia') return consultas.listarBancoTrivia();
  return consultas.listarBancoSupervivencia();
}

export default function BancoPreguntas({ onCerrar }) {
  const [banco, setBanco] = useState('rosco');
  const [filas, setFilas] = useState(null);
  const [cargando, setCargando] = useState(true);
  const [guardandoId, setGuardandoId] = useState(null);
  const [aviso, setAviso] = useState(null);

  // Importador
  const [texto, setTexto] = useState('');
  const [nombreArchivo, setNombreArchivo] = useState(null);
  const [resultadoImport, setResultadoImport] = useState(null);
  const [importando, setImportando] = useState(false);
  const [progresoLectura, setProgresoLectura] = useState(null); 
  const [previewCrudo, setPreviewCrudo] = useState(null);

  // PREVIEW con debounce (esc. 4/7): re-evalúa todo el texto bajo las reglas
  // del modo activo, pero sin re-parsear en cada tecla (los lotes grandes
  // pueden tener miles de líneas).
  useEffect(() => {
    if (!texto.trim()) return undefined;
    const t = setTimeout(() => {
      try {
        setPreviewCrudo(importarBanco(texto, banco));
      } catch {
        setPreviewCrudo(null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [texto, banco]);

  // Sin texto no se muestra preview (el estado viejo se ignora en render).
  const preview = texto.trim() ? previewCrudo : null;

  const cargarBanco = useCallback(async () => {
    setCargando(true);
    try {
      setFilas(await listarBanco(banco));
    } catch (err) {
      setAviso(err.message);
    } finally {
      setCargando(false);
    }
  }, [banco]);

  useEffect(() => {
    let vigente = true;
    listarBanco(banco)
      .then((data) => {
        if (vigente) setFilas(data);
      })
      .catch((err) => {
        if (vigente) setAviso(err.message);
      })
      .finally(() => {
        if (vigente) setCargando(false);
      });
    return () => {
      vigente = false;
    };
  }, [banco]);

  async function guardar(filasNuevas, index) {
    setGuardandoId(index);
    setAviso(null);
    try {
      if (banco === 'rosco') {
        const id = await api.guardarPreguntaRosco(filasNuevas.letra, filasNuevas.pregunta, filasNuevas.respuesta, filasNuevas.id || null);
        setFilas((prev) => {
          if (filasNuevas.id) return prev.map((f) => (f.id === filasNuevas.id ? { ...f, ...filasNuevas } : f));
          return [...prev, { ...filasNuevas, id }];
        });
      } else if (banco === 'trivia') {
        // Esc. 6 — SIN desindexar: `filasNuevas` llega ya consolidada desde la
        // fila (opciones vacías removidas + índice recalculado por posición).
        const id = await api.guardarPreguntaTrivia(filasNuevas.pregunta, filasNuevas.opciones, filasNuevas.indice_correcto, filasNuevas.id || null);
        setFilas((prev) => {
          if (filasNuevas.id) return prev.map((f) => (f.id === filasNuevas.id ? { ...f, pregunta: filasNuevas.pregunta, opciones: filasNuevas.opciones, indice_correcto: filasNuevas.indice_correcto } : f));
          return [...prev, { id, pregunta: filasNuevas.pregunta, opciones: filasNuevas.opciones, indice_correcto: filasNuevas.indice_correcto }];
        });
      } else {
        const id = await api.guardarPreguntaSupervivencia(filasNuevas.pregunta, filasNuevas.es_verdadera, filasNuevas.id || null);
        setFilas((prev) => {
          if (filasNuevas.id) return prev.map((f) => (f.id === filasNuevas.id ? { ...f, ...filasNuevas } : f));
          return [...prev, { ...filasNuevas, id }];
        });
      }
      setAviso(null);
      return true;
    } catch (err) {
      setAviso(err.message);
      return false;
    } finally {
      setGuardandoId(null);
    }
  }

  async function eliminar(id) {
    if (!window.confirm('¿Eliminar esta pregunta?')) return;
    try {
      await api.borrarPregunta(banco, id);
      setFilas((prev) => prev.filter((f) => f.id !== id));
    } catch (err) {
      setAviso(err.message);
    }
  }

  function leerArchivo(e) {
    const archivo = e.target.files?.[0];
    e.target.value = ''; // permite volver a subir el mismo archivo
    if (!archivo) return;
    setAviso(null);
    setNombreArchivo(archivo.name);
    setProgresoLectura(0);
    // Esc. 7 — lectura por CHUNKS: el archivo nunca se materializa entero
    // como ArrayBuffer y la UI no se congela durante la ingesta.
    leerArchivoPorChunks(archivo, (p) => setProgresoLectura(Math.round(p * 100)))
      .then((contenido) => {
        setTexto(contenido);
        setResultadoImport(null);
      })
      .catch((err) => {
        setNombreArchivo(null);
        setAviso(err.message);
      })
      .finally(() => setProgresoLectura(null));
  }

  async function cargarImport() {
    const { items, descartes, formato } = importarBanco(texto, banco);
    if (items.length === 0) {
      setResultadoImport({ ok: false, mensaje: 'No reconocí ninguna pregunta con ese formato. Mirá el ejemplo.' });
      return;
    }
    setImportando(true);
    try {
      const cantidad = await api.cargarBanco(banco, items);
      setResultadoImport({
        ok: true,
        mensaje: `✓ ${cantidad} preguntas cargadas (${formato})${descartes.length ? ` · ${descartes.length} líneas descartadas` : ''}`,
      });
      setTexto('');
      setNombreArchivo(null);
      await cargarBanco();
    } catch (err) {
      setResultadoImport({ ok: false, mensaje: err.message });
    } finally {
      setImportando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-6" onClick={onCerrar}>
      <div
        className="w-full max-w-4xl max-h-[88dvh] overflow-y-auto rounded-3xl border border-white/10 bg-[#0D0720] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-black flex items-center gap-2">
            <FileText size={19} className="text-amber-300" />
            Banco de preguntas
          </h2>
          <button
            onClick={onCerrar}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/5 text-[#B8AFD9] hover:bg-white/15 hover:text-white transition"
          >
            <X size={18} />
          </button>
        </div>

        {/* Selector de banco */}
        <div className="grid grid-cols-3 gap-2 mb-5">
          {BANCOS.map((b) => (
            <button
              key={b.id}
              onClick={() => {
                if (b.id === banco) return;
                setBanco(b.id);
                setResultadoImport(null);
                setCargando(true);
              }}
              className={`rounded-2xl border px-3 py-2.5 text-left transition ${
                banco === b.id
                  ? 'border-amber-400/70 bg-amber-400/10'
                  : 'border-white/10 bg-white/[0.03] hover:border-white/25'
              }`}
            >
              <span className={`block text-sm font-extrabold ${banco === b.id ? 'text-amber-200' : 'text-white'}`}>
                {b.nombre}
              </span>
              <span className="block text-[10px] text-[#8B80B3] leading-tight mt-0.5">{b.detalle}</span>
            </button>
          ))}
        </div>

        {/* IMPORTADOR */}
        <div className="rounded-2xl border border-sky-400/25 bg-sky-400/[0.06] p-4 mb-6">
          <p className="text-sm font-bold text-sky-200 flex items-center gap-2 mb-1">
            <Upload size={15} /> Carga masiva inteligente
          </p>
          <p className="text-[11px] text-[#8B80B3] leading-relaxed mb-3">
            Pegá texto (de PDF, Word o web) o subí un archivo <b>.csv / .tsv</b> (Excel/Sheets),{' '}
            <b>.json</b>, <b>.sql</b> o <b>.txt</b>. Detecto delimitador y columnas solo. Formato ideal por línea
            para {BANCOS.find((b) => b.id === banco).nombre.toLowerCase()}:
            <code className="text-sky-300"> {BANCOS.find((b) => b.id === banco).detalle}</code>
          </p>

          <div className="flex flex-wrap items-center gap-2 mb-2">
            <label className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-bold text-[#B8AFD9] hover:bg-white/10 transition cursor-pointer">
              <Upload size={13} />
              Subir archivo
              <input type="file" accept=".csv,.tsv,.txt,.json,.sql,.md" className="hidden" onChange={leerArchivo} />
            </label>
            {nombreArchivo && (
              <span className="text-[11px] text-sky-300 font-semibold">{nombreArchivo}</span>
            )}
            <button
              type="button"
              onClick={() => setTexto(EJEMPLOS[banco])}
              className="text-[11px] text-[#8B80B3] hover:text-white underline underline-offset-2"
            >
              usar ejemplo
            </button>
            {progresoLectura != null && (
              <span className="flex items-center gap-2 text-[11px] text-sky-300 font-bold">
                <Loader2 className="animate-spin" size={12} /> leyendo… {progresoLectura}%
              </span>
            )}
          </div>

          <textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            rows={4}
            placeholder={EJEMPLOS[banco]}
            className="w-full bg-black/30 border border-white/10 rounded-xl px-3 py-2 text-base outline-none focus:border-sky-400/60 font-mono"
          />

          <div className="flex items-center justify-between gap-3 mt-2 flex-wrap">
            <button
              onClick={cargarImport}
              disabled={!texto.trim() || importando}
              className="flex items-center gap-2 rounded-full bg-gradient-to-r from-sky-400 to-cyan-500 text-[#0B0616] font-black px-5 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition"
            >
              {importando ? <Loader2 className="animate-spin" size={14} /> : <Upload size={14} />}
              {preview?.items?.length ? `Cargar ${preview.items.length} preguntas` : 'Cargar lote'}
            </button>
            {aviso && <p className="text-xs text-red-300">{aviso}</p>}
          </div>

          {preview && (preview.items.length > 0 || preview.descartes.length > 0) && (
            <div className="mt-3 rounded-xl bg-black/30 border border-white/10 p-3 text-xs">
              {preview.items.length > 0 ? (
                <p className="flex items-center gap-1.5 text-green-300 font-bold mb-2">
                  <CheckCircle2 size={13} /> {preview.items.length} reconocidas — así se cargarán:
                </p>
              ) : (
                <p className="flex items-center gap-1.5 text-amber-300 font-bold mb-2">
                  <AlertTriangle size={13} /> No reconocí ninguna línea todavía.
                </p>
              )}
              <ul className="space-y-0.5 text-[11px] text-[#B8AFD9] max-h-24 overflow-y-auto">
                {preview.items.slice(0, 5).map((i, idx) => (
                  <li key={idx} className="truncate">
                    {banco === 'rosco' && <b className="text-amber-300">[{i.letra}]</b>} {i.pregunta}
                    {banco === 'trivia' && <span className="text-[#8B80B3]"> → correcta: {i.opciones?.[i.indice_correcto]}</span>}
                    {banco === 'supervivencia' && <span className="text-[#8B80B3]"> → {i.es_verdadera ? 'V' : 'F'}</span>}
                  </li>
                ))}
                {preview.items.length > 5 && <li className="text-[#6C6193]">… y {preview.items.length - 5} más</li>}
              </ul>
              {preview.descartes.length > 0 && (
                <div className="mt-1.5 rounded-lg border border-amber-400/20 bg-amber-400/5 px-2.5 py-2">
                  <p className="text-[10px] font-bold text-amber-300">
                    {preview.descartes.length} ignoradas por formato (el resto se carga igual):
                  </p>
                  <ul className="mt-1 space-y-0.5 text-[10px] text-amber-200/80 max-h-20 overflow-y-auto">
                    {preview.descartes.slice(0, 5).map((d, idx) => (
                      <li key={idx} className="truncate">
                        {d.n ? <b>Línea {d.n}</b> : <b>Ítem {d.n ?? idx + 1}</b>} ignorado por formato inválido
                        {d.razon ? ` — ${d.razon}` : ''}: “{d.linea}”
                      </li>
                    ))}
                    {preview.descartes.length > 5 && (
                      <li className="text-amber-200/50">… y {preview.descartes.length - 5} más</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}

          {resultadoImport && (
            <p className={`mt-2 text-xs font-bold ${resultadoImport.ok ? 'text-green-300' : 'text-red-300'}`}>
              {resultadoImport.mensaje}
            </p>
          )}
        </div>

        {/* LISTADO / EDICIÓN */}
        {cargando ? (
          <div className="flex items-center justify-center py-10 text-[#B8AFD9]">
            <Loader2 className="animate-spin mr-2" /> Cargando {banco}...
          </div>
        ) : (
          <>
            {banco === 'rosco' && (
              <ListadoRosco filas={filas} guardandoId={guardandoId} guardar={guardar} eliminar={eliminar} />
            )}
            {banco === 'trivia' && (
              <ListadoTrivia filas={filas} guardandoId={guardandoId} guardar={guardar} eliminar={eliminar} />
            )}
            {banco === 'supervivencia' && (
              <ListadoSupervivencia filas={filas} guardandoId={guardandoId} guardar={guardar} eliminar={eliminar} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Listados editables por banco
// (los estados internos RESINCRONIZAN cuando cambia la fila del servidor:
// -----------------------------------------------------------------------
function ListadoRosco({ filas, guardandoId, guardar, eliminar }) {
  const vacia = { letra: 'A', pregunta: '', respuesta: '' };
  const [nueva, setNueva] = useState(vacia);
  const guardarNueva = async (actual) => {
    if (await guardar(actual, 'nueva')) setNueva(vacia);
  };
  return (
    <div className="flex flex-col gap-2">
      <FilaRosco fila={nueva} guardando={guardandoId === 'nueva'} onGuardar={guardarNueva} onEliminar={null} nuevo />
      {filas.map((f) => (
        <FilaRosco key={f.id} fila={f} guardando={guardandoId === f.id} onGuardar={(actual) => guardar(actual, f.id)} onEliminar={() => eliminar(f.id)} />
      ))}
      {filas.length === 0 && <p className="text-sm text-[#6C6193] text-center py-4">Banco vacío. Agregá la primera arriba.</p>}
    </div>
  );
}

function FilaRosco({ fila, guardando, onGuardar, onEliminar, nuevo = false }) {
  // El `id` viaja dentro del estado para que guardar() haga UPDATE y no INSERT.
  const normalizar = () => ({ id: fila.id, letra: fila.letra || 'A', pregunta: fila.pregunta || '', respuesta: fila.respuesta || '' });
  const claveFila = JSON.stringify([fila.id, fila.letra, fila.pregunta, fila.respuesta]);
  const [estado, setEstado] = useState(normalizar);
  const [claveEstado, setClaveEstado] = useState(claveFila);
  // Resincroniza el editor cuando la fila del servidor cambia (patrón React
  // "adjusting state during render": evita el efecto con deps incompletas).
  if (claveEstado !== claveFila) {
    setClaveEstado(claveFila);
    setEstado(normalizar());
  }

  const modificado = nuevo || claveFila !== JSON.stringify([estado.id, estado.letra, estado.pregunta, estado.respuesta]);
  return (
    <div className="grid grid-cols-[2.5rem_1fr_1fr_auto] gap-2 items-center">
      <input
        value={estado.letra}
        onChange={(e) => setEstado({ ...estado, letra: e.target.value.toUpperCase().slice(0, 1) })}
        className="h-10 rounded-lg bg-white/[0.05] border border-white/10 text-center font-black text-amber-300 outline-none focus:border-amber-400/70"
      />
      <input
        value={estado.pregunta}
        onChange={(e) => setEstado({ ...estado, pregunta: e.target.value })}
        placeholder="Pregunta..."
        className="h-10 rounded-lg bg-white/[0.05] border border-white/10 px-3 text-base outline-none focus:border-amber-400/70"
      />
      <input
        value={estado.respuesta}
        onChange={(e) => setEstado({ ...estado, respuesta: e.target.value })}
        placeholder="Respuesta correcta"
        className="h-10 rounded-lg bg-white/[0.05] border border-white/10 px-3 text-base outline-none focus:border-green-400/70"
      />
      <span className="flex items-center gap-1">
        <button
          onClick={() => onGuardar(estado)}
          disabled={!modificado || !estado.pregunta.trim() || !estado.respuesta.trim() || guardando}
          title="Guardar"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-[#B8AFD9] hover:border-amber-400/60 hover:text-amber-300 transition disabled:opacity-30"
        >
          {guardando ? <Loader2 className="animate-spin" size={15} /> : <Save size={15} />}
        </button>
        {onEliminar && (
          <button
            onClick={onEliminar}
            title="Eliminar"
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/10 text-[#B8AFD9] hover:border-red-400/60 hover:text-red-300 transition"
          >
            <Trash2 size={15} />
          </button>
        )}
      </span>
    </div>
  );
}

function ListadoTrivia({ filas, guardandoId, guardar, eliminar }) {
  const vacia = { pregunta: '', opciones: ['', '', '', ''], indice_correcto: 0 };
  const [nueva, setNueva] = useState(vacia);
  const guardarNueva = async (actual) => {
    if (await guardar(actual, 'nueva')) setNueva(vacia);
  };
  return (
    <div className="flex flex-col gap-3">
      <FilaTrivia fila={nueva} guardando={guardandoId === 'nueva'} onGuardar={guardarNueva} onEliminar={null} nuevo />
      {filas.map((f) => (
        <FilaTrivia key={f.id} fila={f} guardando={guardandoId === f.id} onGuardar={(actual) => guardar(actual, f.id)} onEliminar={() => eliminar(f.id)} />
      ))}
      {filas.length === 0 && <p className="text-sm text-[#6C6193] text-center py-4">Banco vacío. Agregá la primera arriba.</p>}
    </div>
  );
}

function FilaTrivia({ fila, guardando, onGuardar, onEliminar, nuevo = false }) {
  const normalizar = () => ({
    id: fila.id,
    pregunta: fila.pregunta || '',
    opciones: fila.opciones ? [...fila.opciones, '', '', '', ''].slice(0, 4) : ['', '', '', ''],
    indice_correcto: fila.indice_correcto ?? 0,
  });
  const claveFila = JSON.stringify([fila.id, fila.pregunta, fila.opciones, fila.indice_correcto]);
  const [estado, setEstado] = useState(normalizar);
  const [claveEstado, setClaveEstado] = useState(claveFila);
  if (claveEstado !== claveFila) {
    setClaveEstado(claveFila);
    setEstado(normalizar());
  }

  const consolidada = consolidarTrivia(estado);
  // Compara lo consolidado contra la fila original (sin el padding a 4).
  const original = JSON.stringify([
    (fila.pregunta || '').trim(),
    (fila.opciones || []).map((o) => String(o).trim()),
    fila.indice_correcto ?? 0,
  ]);
  const actual = JSON.stringify([consolidada.pregunta, consolidada.opciones, consolidada.indice_correcto]);
  const modificado = nuevo || original !== actual;
  // La correcta no puede quedar vacía, y hacen falta al menos 2 opciones.
  const puedoGuardar = modificado && estado.pregunta.trim() && !consolidada.correctaPerdida && consolidada.opciones.length >= 2;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3">
      <div className="flex gap-2">
        <input
          value={estado.pregunta}
          onChange={(e) => setEstado({ ...estado, pregunta: e.target.value })}
          placeholder="Pregunta..."
          className="flex-1 h-10 rounded-lg bg-white/[0.05] border border-white/10 px-3 text-base outline-none focus:border-sky-400/70"
        />
        <span className="flex items-center gap-1">
          <button
            onClick={() => onGuardar({ ...consolidada, id: fila.id })}
            disabled={!puedoGuardar || guardando}
            title={
              consolidada.correctaPerdida
                ? 'La opción marcada como correcta está vacía'
                : 'Guardar'
            }
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 text-[#B8AFD9] hover:border-sky-400/60 hover:text-sky-300 transition disabled:opacity-30"
          >
            {guardando ? <Loader2 className="animate-spin" size={15} /> : <Save size={15} />}
          </button>
          {onEliminar && (
            <button onClick={onEliminar} title="Eliminar" className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 text-[#B8AFD9] hover:border-red-400/60 hover:text-red-300 transition">
              <Trash2 size={15} />
            </button>
          )}
        </span>
      </div>
      {consolidada.correctaPerdida && (
        <p className="mt-1.5 text-[11px] font-bold text-amber-300">
          La opción marcada como correcta está vacía: escribila o marcá otra.
        </p>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
        {estado.opciones.map((op, i) => (
          <div key={i} className="relative">
            <input
              value={op}
              onChange={(e) => {
                const opciones = [...estado.opciones];
                opciones[i] = e.target.value;
                setEstado({ ...estado, opciones });
              }}
              placeholder={`Opción ${i + 1}`}
              className={`w-full h-9 rounded-lg bg-white/[0.05] border px-3 pr-7 text-base outline-none transition ${
                estado.indice_correcto === i ? 'border-green-400/70 text-green-200' : 'border-white/10'
              }`}
            />
            <button
              onClick={() => setEstado({ ...estado, indice_correcto: i })}
              title="Marcar como correcta"
              className={`absolute right-2 top-1/2 -translate-y-1/2 h-5 w-5 rounded-full border-2 transition ${
                estado.indice_correcto === i ? 'bg-green-400 border-green-400' : 'border-white/25 hover:border-white/50'
              }`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ListadoSupervivencia({ filas, guardandoId, guardar, eliminar }) {
  const vacia = { pregunta: '', es_verdadera: true };
  const [nueva, setNueva] = useState(vacia);
  const guardarNueva = async (actual) => {
    if (await guardar(actual, 'nueva')) setNueva(vacia);
  };
  return (
    <div className="flex flex-col gap-2">
      <FilaSupervivencia fila={nueva} guardando={guardandoId === 'nueva'} onGuardar={guardarNueva} onEliminar={null} nuevo />
      {filas.map((f) => (
        <FilaSupervivencia key={f.id} fila={f} guardando={guardandoId === f.id} onGuardar={(actual) => guardar(actual, f.id)} onEliminar={() => eliminar(f.id)} />
      ))}
      {filas.length === 0 && <p className="text-sm text-[#6C6193] text-center py-4">Banco vacío. Agregá la primera arriba.</p>}
    </div>
  );
}

function FilaSupervivencia({ fila, guardando, onGuardar, onEliminar, nuevo = false }) {
  const normalizar = () => ({ id: fila.id, pregunta: fila.pregunta || '', es_verdadera: fila.es_verdadera ?? true });
  const claveFila = JSON.stringify([fila.id, fila.pregunta, fila.es_verdadera]);
  const [estado, setEstado] = useState(normalizar);
  const [claveEstado, setClaveEstado] = useState(claveFila);
  if (claveEstado !== claveFila) {
    setClaveEstado(claveFila);
    setEstado(normalizar());
  }

  const modificado = nuevo || claveFila !== JSON.stringify([estado.id, estado.pregunta, estado.es_verdadera]);
  return (
    <div className="flex gap-2 items-center">
      <input
        value={estado.pregunta}
        onChange={(e) => setEstado({ ...estado, pregunta: e.target.value })}
        placeholder="Frase para responder Verdadero o Falso..."
        className="flex-1 h-10 rounded-lg bg-white/[0.05] border border-white/10 px-3 text-base outline-none focus:border-red-400/70"
      />
      <button
        onClick={() => setEstado({ ...estado, es_verdadera: true })}
        className={`h-10 px-3 rounded-lg text-xs font-black transition ${estado.es_verdadera ? 'bg-green-500/25 text-green-300 border border-green-400/50' : 'bg-white/5 text-[#6C6193] border border-white/10'}`}
      >
        V
      </button>
      <button
        onClick={() => setEstado({ ...estado, es_verdadera: false })}
        className={`h-10 px-3 rounded-lg text-xs font-black transition ${!estado.es_verdadera ? 'bg-red-500/25 text-red-300 border border-red-400/50' : 'bg-white/5 text-[#6C6193] border border-white/10'}`}
      >
        F
      </button>
      <span className="flex items-center gap-1">
        <button
          onClick={() => onGuardar(estado)}
          disabled={!modificado || !estado.pregunta.trim() || guardando}
          title="Guardar"
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 text-[#B8AFD9] hover:border-red-400/60 hover:text-red-300 transition disabled:opacity-30"
        >
          {guardando ? <Loader2 className="animate-spin" size={15} /> : <Save size={15} />}
        </button>
        {onEliminar && (
          <button onClick={onEliminar} title="Eliminar" className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 text-[#B8AFD9] hover:border-red-400/60 hover:text-red-300 transition">
            <Trash2 size={15} />
          </button>
        )}
      </span>
    </div>
  );
}
