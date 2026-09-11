-- =============================================================================
-- KALDORA v2 — Seed de contenido (Trivia, Basta, Supervivencia)
-- =============================================================================
-- Solo inserta si la tabla está vacía, para no pisar contenido propio.
-- El rosco conserva su seed original (20260102000000_seed.sql).

-- -----------------------------------------------------------------------------
-- Trivia de velocidad (opciones; indice_correcto es 0-based)
-- -----------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.preguntas_trivia) > 0 then
    return;
  end if;

  insert into public.preguntas_trivia (pregunta, opciones, indice_correcto) values
    ('¿Cuál es el río más largo del mundo?', array['Nilo','Amazonas','Yangtsé','Misisipi'], 1),
    ('¿En qué año llegó el hombre a la Luna?', array['1965','1969','1972','1958'], 1),
    ('¿Cuál es el elemento químico con símbolo Au?', array['Plata','Oro','Aluminio','Argón'], 1),
    ('¿Cuántos huesos tiene el cuerpo humano adulto?', array['206','186','256','306'], 0),
    ('¿Cuál es el país más grande del mundo?', array['Canadá','China','Rusia','Estados Unidos'], 2),
    ('¿Quién pintó "La noche estrellada"?', array['Monet','Van Gogh','Picasso','Dalí'], 1),
    ('¿Cuál es el océano más grande?', array['Atlántico','Índico','Pacífico','Ártico'], 2),
    ('¿Cuántos jugadores tiene un equipo de fútbol en cancha?', array['9','10','11','12'], 2),
    ('¿Qué gas respiran las plantas para hacer fotosíntesis?', array['Oxígeno','Nitrógeno','Dióxido de carbono','Hidrógeno'], 2),
    ('¿Cuál es la capital de Australia?', array['Sídney','Melbourne','Canberra','Perth'], 2),
    ('¿Quién escribió "Cien años de soledad"?', array['Borges','García Márquez','Cortázar','Vargas Llosa'], 1),
    ('¿Cuál es el planeta más cercano al Sol?', array['Venus','Mercurio','Marte','Tierra'], 1),
    ('¿Cuánto es 12 x 12?', array['124','132','144','156'], 2),
    ('¿Cuál es el idioma más hablado del mundo (nativos)?', array['Inglés','Español','Mandarín','Hindi'], 2),
    ('¿Qué animal es el más rápido en tierra?', array['León','Guepardo','Antílope','Caballo'], 1),
    ('¿En qué continente está Egipto?', array['Asia','África','Europa','Oceanía'], 1),
    ('¿Cuál es el metal líquido a temperatura ambiente?', array['Mercurio','Plomo','Estaño','Cobre'], 0),
    ('¿Cuántos corazones tiene un pulpo?', array['1','2','3','4'], 2),
    ('¿Qué instrumento mide la temperatura?', array['Barómetro','Termómetro','Higrómetro','Anemómetro'], 1),
    ('¿Cuál es la moneda de Japón?', array['Won','Yuan','Yen','Ringgit'], 2);
end $$;

-- -----------------------------------------------------------------------------
-- Categorías del Basta (se eligen 5 al azar por ronda)
-- -----------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.categorias_basta) > 0 then
    return;
  end if;

  insert into public.categorias_basta (nombre) values
    ('Nombre de persona'),
    ('Animal'),
    ('País o ciudad'),
    ('Color'),
    ('Comida o plato'),
    ('Fruta o verdura'),
    ('Objeto de la casa'),
    ('Película o serie'),
    ('Deporte'),
    ('Profesión u oficio'),
    ('Marca o invento'),
    ('Cosa que se encuentra en el mar');
end $$;

-- -----------------------------------------------------------------------------
-- Supervivencia (frases para responder Verdadero o Falso)
-- -----------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.preguntas_supervivencia) > 0 then
    return;
  end if;

  insert into public.preguntas_supervivencia (pregunta, es_verdadera) values
    ('El corazón de un camarón está en su cabeza.', true),
    ('Los murciélagos son ciegos.', false),
    ('El monte Everest es la montaña más alta del mundo.', true),
    ('Una hora tiene 3600 segundos.', true),
    ('Los pingüinos viven en el Ártico.', false),
    ('La ballena azul es el animal más grande que ha existido.', true),
    ('El tomate es una verdura.', false),
    ('Einstein aprobó matemáticas con facilidad de niño.', false),
    ('Los dedos de la mano no tienen huesos.', false),
    ('Australia es a la vez un país y un continente.', true),
    ('El rayo es 5 veces más caliente que la superficie del Sol.', true),
    ('Los humanos comparten el 60% de su ADN con los plátanos.', true),
    ('La Gran Muralla China se ve desde la Luna a simple vista.', false),
    ('El agua cubre el 71% de la superficie terrestre.', true),
    ('Napoleón era extremadamente bajo para su época.', false),
    ('Las arañas tienen 8 patas.', true),
    ('Venus es el planeta más caliente del sistema solar.', true),
    ('El ajedrez nació en Rusia.', false),
    ('Las medusas no tienen cerebro ni corazón.', true),
    ('El dinero más caro del mundo es el bitcoin.', false),
    ('Cada persona tiene una lengua con huella única.', true),
    ('Los tiburones existían antes que los árboles.', true),
    ('Los polos de un imán se repelen si son iguales.', true),
    ('La Torre Eiffel crece en verano.', true);
end $$;
