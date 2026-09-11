// src/components/Rosco.jsx
//
// Rosco circular (estilo "Pasapalabra") dibujado en SVG puro.
// Recibe el estado de cada letra y pinta el círculo correspondiente:
//   'pendiente' -> gris neutro
//   'activa'    -> anillo dorado pulsante (letra en juego ahora mismo)
//   'acierto'   -> verde
//   'error'     -> rojo
//   'pasapalabra' -> amarillo
//
// El anillo ROTATION SUAVE hacia la letra activa (queda arriba, estilo TV)
// y las letras se contra-rotan para seguir derechas.
//
// Es un componente puramente visual: no sabe de Supabase ni de turnos,
// solo recibe props y dibuja. Así sirve tanto para el jugador activo
// como para la vista de espectador.

import React, { useMemo } from 'react';

const LETRAS = 'ABCDEFGHIJKLMNÑOPQRSTUVWXYZ'.split(''); // 27 letras, incluye Ñ
const SUAVE = 'transform 0.7s cubic-bezier(0.3, 1, 0.35, 1)';

const COLORES_ESTADO = {
  pendiente: { relleno: '#2A2440', borde: '#463C6E', texto: '#B8AFD9' },
  activa: { relleno: '#F2B705', borde: '#FFD84D', texto: '#1B1035' },
  acierto: { relleno: '#22C55E', borde: '#4ADE80', texto: '#08260F' },
  error: { relleno: '#EF4444', borde: '#F87171', texto: '#2A0505' },
  pasapalabra: { relleno: '#EAB308', borde: '#FDE047', texto: '#2A2205' },
};

/**
 * @param {Object} props
 * @param {Object} props.estados - Mapa { A: 'acierto', B: 'pendiente', ... }
 * @param {string} props.letraActual - Letra que está en juego ahora (para resaltar)
 * @param {number} [props.tamano=420] - Tamaño en px del SVG (cuadrado)
 */
export default function Rosco({ estados = {}, letraActual = null, tamano = 420 }) {
  const centro = tamano / 2;
  const radio = tamano * 0.42;
  const radioLetra = tamano * 0.052;

  // Rotación del anillo: la letra activa queda arriba (estilo TV).
  const rotacion = useMemo(() => {
    const idx = letraActual ? LETRAS.indexOf(letraActual) : -1;
    return idx >= 0 ? -(idx / LETRAS.length) * 360 : 0;
  }, [letraActual]);

  const posiciones = useMemo(() => {
    return LETRAS.map((letra, i) => {
      // Empezamos en la parte superior (-90°) y repartimos las 27 letras en el círculo
      const angulo = (i / LETRAS.length) * 2 * Math.PI - Math.PI / 2;
      const x = centro + radio * Math.cos(angulo);
      const y = centro + radio * Math.sin(angulo);
      return { letra, x, y };
    });
  }, [centro, radio]);

  return (
    <svg
      viewBox={`0 0 ${tamano} ${tamano}`}
      width="100%"
      height="100%"
      role="img"
      aria-label="Rosco de letras del juego"
      className="max-w-full h-auto"
    >
      {/* Pista de fondo del rosco */}
      <circle
        cx={centro}
        cy={centro}
        r={radio}
        fill="none"
        stroke="#332B52"
        strokeWidth={2}
      />

      {/* El anillo entero rota hacia la letra activa (las letras se
          contra-rotan para quedar derechas). */}
      <g
        style={{
          transform: `rotate(${rotacion}deg)`,
          transformOrigin: `${centro}px ${centro}px`,
          transition: SUAVE,
        }}
      >
        {posiciones.map(({ letra, x, y }) => {
          const esActiva = letra === letraActual;
          const estado = esActiva ? 'activa' : estados[letra] || 'pendiente';
          const { relleno, borde, texto } = COLORES_ESTADO[estado];

          return (
            <g
              key={letra}
              style={{
                transform: `rotate(${-rotacion}deg)`,
                transformOrigin: `${x}px ${y}px`,
                transition: SUAVE,
              }}
            >
              <circle
                cx={x}
                cy={y}
                r={radioLetra}
                fill={relleno}
                stroke={borde}
                strokeWidth={esActiva ? 3 : 1.5}
                style={
                  esActiva
                    ? { filter: 'drop-shadow(0 0 7px rgba(242, 183, 5, 0.75))' }
                    : undefined
                }
              >
                {esActiva && (
                  <animate
                    attributeName="r"
                    values={`${radioLetra};${radioLetra * 1.12};${radioLetra}`}
                    dur="1.4s"
                    repeatCount="indefinite"
                  />
                )}
              </circle>
              <text
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={radioLetra * 1.05}
                fontWeight={esActiva ? 700 : 600}
                fill={texto}
              >
                {letra}
              </text>
            </g>
          );
        })}
      </g>

      {/* Centro: letra actual en grande, para que el espectador la ubique rápido */}
      {letraActual && (
        <text
          x={centro}
          y={centro}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={tamano * 0.14}
          fontWeight={800}
          fill="#F2B705"
          className="font-display animate-pulso-letra"
          style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
        >
          {letraActual}
        </text>
      )}
    </svg>
  );
}

export { LETRAS };
