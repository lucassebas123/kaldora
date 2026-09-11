import { supabase } from '../supabaseClient';

// ---------------------------------------------------------------------------
// Sesión del jugador (por dispositivo)
// ---------------------------------------------------------------------------
const JUGADOR_KEY = 'kaldora_jugador';

export function leerSesionJugador() {
  try {
    const crudo = localStorage.getItem(JUGADOR_KEY);
    return crudo ? JSON.parse(crudo) : null;
  } catch {
    localStorage.removeItem(JUGADOR_KEY);
    return null;
  }
}

export function guardarSesionJugador(sesion) {
  localStorage.setItem(JUGADOR_KEY, JSON.stringify(sesion));
}

export function borrarSesionJugador() {
  localStorage.removeItem(JUGADOR_KEY);
}

// Arma y persiste la sesión del jugador a partir de la respuesta de una RPC
// de entrada (unirse_sala / entrar_con_identificador).
function guardarSesionDesdeRpc(data, extras = {}) {
  const sesion = {
    idSala: data.idSala,
    codigo: data.codigo,
    idJugador: data.idJugador,
    nickname: data.nickname,
    token: data.token,
    icono: extras.icono,
    color: extras.color,
  };
  guardarSesionJugador(sesion);
  return {
    ...sesion,
    pinJugador: data.pinJugador ?? null,
    recurrente: Boolean(data.recurrente),
  };
}

// ---------------------------------------------------------------------------
// Envoltorio de RPC con errores tipados
// ---------------------------------------------------------------------------
function envolver(promise) {
  return promise.then(({ data, error }) => {
    if (error) {
      const err = new Error(error.message || 'Error de servidor');
      err.code = error.code;
      throw err;
    }
    return data;
  });
}

function rpc(nombre, parametros) {
  return envolver(supabase.rpc(nombre, parametros));
}

// Token del jugador de la sesión activa (o null fuera del juego).
function tokenJugador() {
  return leerSesionJugador()?.token || null;
}

// ---
// API
// ---
export const api = {
  // ---- Anfitrión (Supabase Auth)
  crearSala: () => rpc('crear_sala'),
  misSalas: () => rpc('mis_salas'),
  borrarSala: (idSala) => rpc('borrar_sala', { p_sala: idSala }),
  seleccionarJuego: (idSala, juego) =>
    rpc('seleccionar_juego', { p_sala: idSala, p_juego: juego }),
  pausarPartida: (idSala) => rpc('pausar_partida', { p_sala: idSala }),
  reanudarPartida: (idSala) => rpc('reanudar_partida', { p_sala: idSala }),
  terminarPartida: (idSala) => rpc('terminar_partida', { p_sala: idSala }),
  volverAlLobby: (idSala) => rpc('volver_al_lobby', { p_sala: idSala }),
  expulsarJugador: (idSala, idJugador) =>
    rpc('expulsar_jugador', { p_sala: idSala, p_jugador: idJugador }),
  cargarBanco: (banco, items) => rpc('cargar_banco', { p_banco: banco, p_items: items }),
  guardarPreguntaRosco: (letra, pregunta, respuesta, idPregunta) =>
    rpc('guardar_pregunta_rosco', {
      p_letra: letra,
      p_pregunta: pregunta,
      p_respuesta: respuesta,
      p_pregunta_id: idPregunta,
    }),
  guardarPreguntaTrivia: (pregunta, opciones, indice, idPregunta) =>
    rpc('guardar_pregunta_trivia', {
      p_pregunta: pregunta,
      p_opciones: opciones,
      p_indice: indice,
      p_pregunta_id: idPregunta,
    }),
  guardarPreguntaSupervivencia: (pregunta, esVerdadera, idPregunta) =>
    rpc('guardar_pregunta_supervivencia', {
      p_pregunta: pregunta,
      p_es_verdadera: esVerdadera,
      p_pregunta_id: idPregunta,
    }),
  borrarPregunta: (banco, idPregunta) => rpc('borrar_pregunta', { p_banco: banco, p_id: idPregunta }),
  cambiarRolAdmin: (idAdmin, rol) => rpc('cambiar_rol_admin', { p_id: idAdmin, p_rol: rol }),
  quitarAdmin: (idAdmin) => rpc('quitar_admin', { p_id: idAdmin }),

  // ---- Jugador ----
  unirseSala: async (codigo, { nickname, nombre, apellido, telefono, correo, icono, color }) => {
    const data = await rpc('unirse_sala', {
      p_codigo: codigo,
      p_nickname: nickname,
      p_nombre: nombre,
      p_apellido: apellido,
      p_telefono: telefono,
      p_correo: correo,
      p_icono: icono,
      p_color: color,
    });
    return guardarSesionDesdeRpc(data, { icono, color });
  },
  entrarConIdentificador: async (codigo, identificador, { icono, color } = {}) => {
    const data = await rpc('entrar_con_identificador', {
      p_codigo: codigo,
      p_identificador: identificador,
      p_icono: icono,
      p_color: color,
    });
    return guardarSesionDesdeRpc(data, { icono, color });
  },
  salirSala: (token = tokenJugador()) => rpc('salir_sala', { p_token: token }),

  // ---- Rosco----
  roscoIniciar: (idSala, duracionSeg) =>
    rpc('rosco_iniciar', { p_sala: idSala, p_duracion_seg: duracionSeg }),
  roscoEnviar: (respuesta) =>
    rpc('rosco_enviar', { p_token: tokenJugador(), p_respuesta: respuesta }),
  roscoPasar: () => rpc('rosco_pasar', { p_token: tokenJugador() }),
  roscoCerrar: () => rpc('rosco_cerrar', { p_token: tokenJugador() }),
  roscoEstado: () => rpc('rosco_estado', { p_token: tokenJugador() }),
  perfilPorCorreo: (correo) => rpc('perfil_por_correo', { p_correo: correo }),

  // ---- Trivia ----
  triviaSiguiente: (idSala, duracionMs) =>
    rpc('trivia_siguiente', { p_sala: idSala, p_duracion_ms: duracionMs }),
  triviaResponder: (opcion) =>
    rpc('trivia_responder', { p_token: tokenJugador(), p_opcion: opcion }),

  // ---- Basta ----
  bastaIniciarRonda: (idSala) => rpc('basta_iniciar_ronda', { p_sala: idSala }),
  bastaEnviar: (idCategoria, texto) =>
    rpc('basta_enviar', {
      p_token: tokenJugador(),
      p_id_categoria: idCategoria,
      p_texto: texto,
    }),
  bastaDeclararCompleto: () => rpc('basta_declarar_completo', { p_token: tokenJugador() }),
  bastaCerrarRonda: (idSala) => rpc('basta_cerrar_ronda', { p_sala: idSala }),
  bastaToggleValida: (idSala, idRespuesta, valida) =>
    rpc('basta_toggle_valida', {
      p_sala: idSala,
      p_id_respuesta: idRespuesta,
      p_valida: valida,
    }),

  // ---- Supervivencia ----
  supervivenciaSiguiente: (idSala, duracionMs) =>
    rpc('supervivencia_siguiente', { p_sala: idSala, p_duracion_ms: duracionMs }),
  supervivenciaResponder: (respuesta) =>
    rpc('supervivencia_responder', { p_token: tokenJugador(), p_respuesta: respuesta }),
  supervivenciaProcesar: (idSala, idPreguntaEsperada) =>
    rpc('supervivencia_procesar', {
      p_sala: idSala,
      p_pregunta_id_esperada: idPreguntaEsperada,
    }),
};

// --------------------------------------------------
// Consultas de lectura (RLS: solo columnas públicas)
// --------------------------------------------------
export const consultas = {
  salaPorCodigo: async (codigo) => {
    const { data, error } = await supabase
      .from('salas')
      .select('id, codigo, estado, juego_actual')
      .eq('codigo', String(codigo).trim())
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },

  preguntaRoscoPorId: async (idPregunta) => {
    if (!idPregunta) return null;
    const { data, error } = await supabase
      .from('preguntas')
      .select('id, letra, pregunta')
      .eq('id', idPregunta)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },

  preguntaTriviaPorId: async (idPregunta) => {
    if (!idPregunta) return null;
    const { data, error } = await supabase
      .from('preguntas_trivia')
      .select('id, pregunta, opciones')
      .eq('id', idPregunta)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },

  preguntaTriviaConRespuesta: async (idPregunta) => {
    if (!idPregunta) return null;
    const { data, error } = await supabase
      .from('preguntas_trivia')
      .select('id, pregunta, opciones, indice_correcto')
      .eq('id', idPregunta)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },

  preguntaSupervivenciaPorId: async (idPregunta) => {
    if (!idPregunta) return null;
    const { data, error } = await supabase
      .from('preguntas_supervivencia')
      .select('id, pregunta')
      .eq('id', idPregunta)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },

  preguntaSupervivenciaConRespuesta: async (idPregunta) => {
    if (!idPregunta) return null;
    const { data, error } = await supabase
      .from('preguntas_supervivencia')
      .select('id, pregunta, es_verdadera')
      .eq('id', idPregunta)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },

  categoriasBasta: async () => {
    const { data, error } = await supabase
      .from('categorias_basta')
      .select('id, nombre')
      .order('nombre');
    if (error) throw new Error(error.message);
    return data || [];
  },

  misRespuestasBasta: async (idJugador) => {
    const { data, error } = await supabase
      .from('respuestas_basta')
      .select('id, id_categoria, texto, valida, unico, puntos, existe, corresponde')
      .eq('id_jugador', idJugador);
    if (error) throw new Error(error.message);
    return data || [];
  },

  respuestasBastaDeSala: async (idSala) => {
    const { data, error } = await supabase
      .from('respuestas_basta')
      .select('id, id_jugador, id_categoria, texto, valida, unico, puntos, existe, corresponde')
      .eq('id_sala', idSala);
    if (error) throw new Error(error.message);
    return data || [];
  },

  respuestasTriviaDeRonda: async (idSala, idPregunta) => {
    const { data, error } = await supabase
      .from('trivia_respuestas')
      .select('id, id_jugador, correcta, puntos')
      .eq('id_sala', idSala)
      .eq('id_pregunta', idPregunta);
    if (error) throw new Error(error.message);
    return data || [];
  },

  // ---- Bancos completos ----
  listarBancoRosco: async () => {
    const { data, error } = await supabase
      .from('preguntas')
      .select('id, letra, pregunta, respuesta')
      .order('letra')
      .order('pregunta');
    if (error) throw new Error(error.message);
    return data || [];
  },
  listarBancoTrivia: async () => {
    const { data, error } = await supabase
      .from('preguntas_trivia')
      .select('id, pregunta, opciones, indice_correcto')
      .order('creado_en');
    if (error) throw new Error(error.message);
    return data || [];
  },
  listarBancoSupervivencia: async () => {
    const { data, error } = await supabase
      .from('preguntas_supervivencia')
      .select('id, pregunta, es_verdadera')
      .order('creado_en');
    if (error) throw new Error(error.message);
    return data || [];
  },
  listarAdmins: async () => {
    const { data, error } = await supabase
      .from('admins_autorizados')
      .select('id, email, rol, creado_en')
      .order('rol')
      .order('creado_en');
    if (error) throw new Error(error.message);
    return data || [];
  },
};
