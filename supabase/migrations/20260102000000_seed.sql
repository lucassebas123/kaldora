-- =============================================================================
-- El Rosco - Seed opcional
-- =============================================================================
-- Banco de preguntas de ejemplo (una o dos por letra, incluye Ñ).
-- Solo inserta si la tabla 'preguntas' está vacía para no pisar carga editada.
-- Editable luego desde la pantalla del anfitrión ("Gestionar Preguntas").

do $$
begin
  if (select count(*) from public.preguntas) > 0 then
    return;
  end if;

  insert into public.preguntas (letra, pregunta, respuesta) values
    ('A', 'Capital de Francia', 'París'),
    ('A', 'Mamífero que pone huevos y tiene pico de pato', 'Ornitorrinco'),
    ('B', 'Hueso más largo del cuerpo humano', 'Fémur'),
    ('B', 'Instrumento musical de viento hecho de metal', 'Trompeta'),
    ('C', 'País cuya capital es Bogotá', 'Colombia'),
    ('C', 'Medio de transporte de dos ruedas con pedales', 'Bicicleta'),
    ('D', 'Mamífero marino inteligente y juguetón', 'Delfín'),
    ('E', 'Animal terrestre más grande, con trompa', 'Elefante'),
    ('F', 'Deporte que se juega con los pies y una pelota', 'Fútbol'),
    ('F', 'Frutilla u otra fruta pequeña y roja que se usa en postres', 'Frutilla'),
    ('G', 'Instrumento de cuerdas de seis cuerdas', 'Guitarra'),
    ('H', 'Insecto muy trabajador que vive en colonias', 'Hormiga'),
    ('I', 'Reptil herbívoro típico de zonas tropicales', 'Iguana'),
    ('J', 'Animal africano con el cuello muy largo', 'Jirafa'),
    ('K', 'Arte marcial de origen japonés', 'Karate'),
    ('L', 'Fruta cítrica amarilla y ácida', 'Limón'),
    ('M', 'País que limita al sur con Estados Unidos', 'México'),
    ('M', 'Producto lácteo que se obtiene al batir la crema', 'Manteca'),
    ('N', 'Fruta cítrica de color naranja', 'Naranja'),
    ('Ñ', 'Ave sudamericana que no vuela, parecida al avestruz', 'Ñandú'),
    ('O', 'Gran masa de agua salada que cubre la mayor parte de la Tierra', 'Océano'),
    ('P', 'Instrumento musical de teclas', 'Piano'),
    ('P', 'Continente donde se encuentra Egipto', 'África'),
    ('Q', 'Protagonista de la famosa novela de Cervantes', 'Quijote'),
    ('R', 'Corriente natural de agua que desemboca en el mar', 'Río'),
    ('S', 'Estrella que da luz y calor a la Tierra', 'Sol'),
    ('T', 'Provincia argentina famosa por su limón', 'Tucumán'),
    ('U', 'País cuya capital es Montevideo', 'Uruguay'),
    ('V', 'Animal que da la leche', 'Vaca'),
    ('W', 'Bebida alcohólica destilada a partir de cereales', 'Whisky'),
    ('X', 'Instrumento de percusión con láminas de madera', 'Xilófono'),
    ('Y', 'Planta con la que se prepara el mate', 'Yerba'),
    ('Z', 'Calzado que cubre el pie', 'Zapato');
end $$;