// src/components/BotonMusica.jsx
//
// Interruptor flotante de la música ambiente (esquina inferior derecha).
// Persiste la preferencia en localStorage; la música arranca tras el primer
// gesto del usuario (política de autoplay de los navegadores).

import React, { useEffect, useState } from 'react';
import { Music, VolumeX } from 'lucide-react';
import { alternarMute, estaMuteado, armarAutoplay, setTema } from '../utils/musica';

/**
 * @param {string} tema - tema musical del contexto actual
 *   ('portal' | 'sala' | 'rosco' | 'trivia' | 'basta' | 'supervivencia' | 'podio')
 */
export default function BotonMusica({ tema = 'portal' }) {
  const [muteado, setMuteado] = useState(() => estaMuteado());

  // Cambia el tema en vivo cuando cambia el contexto de la página.
  useEffect(() => {
    setTema(tema);
  }, [tema]);

  // Autoplay: primer gesto del usuario.
  useEffect(() => {
    armarAutoplay();
  }, []);

  function alternar() {
    setMuteado(alternarMute());
  }

  return (
    <button
      onClick={alternar}
      title={muteado ? 'Encender la música' : 'Apagar la música'}
      aria-label={muteado ? 'Encender la música' : 'Apagar la música'}
      className={`fixed flotante-abajo-derecha z-50 flex h-11 w-11 items-center justify-center rounded-full border backdrop-blur-md transition active:scale-95 ${
        muteado
          ? 'border-white/15 bg-white/5 text-[#8B80B3] hover:text-white'
          : 'border-fuchsia-400/40 bg-fuchsia-500/15 text-fuchsia-300 hover:bg-fuchsia-500/25'
      }`}
    >
      {muteado ? <VolumeX size={19} /> : (
        <span className="relative">
          <Music size={19} />
          <span className="absolute -top-1 -right-1.5 flex h-1.5 w-1.5 animate-ping rounded-full bg-fuchsia-400" />
        </span>
      )}
    </button>
  );
}
