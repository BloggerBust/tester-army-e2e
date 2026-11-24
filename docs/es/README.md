# Documentación en español

La traducción al español de la documentación de e2e. El sitio sirve cada página de
esta carpeta en `/docs/es/<ruta>`; una página sin traducción muestra la página en
inglés con un aviso. El inglés sigue siendo la fuente de verdad.

Esta traducción es de mejor esfuerzo. Los cambios en inglés no esperan a la
traducción, así que una página puede ir por detrás de su página en inglés hasta
que alguien que lea español la actualice. `pnpm docs:check` avisa de las páginas
y etiquetas cuya estructura o código difieren del inglés; no detecta un cambio
que solo afecte al texto.

## Estructura

- `docs/es/<ruta>.mdx` traduce `docs/<ruta>.mdx`: misma ruta, mismo nombre de archivo.
- `navigation.json` contiene las etiquetas en español de cada pestaña y grupo de
  `docs/docs.json` (`tabs`, `groups`), con la etiqueta en inglés como clave. El
  orden y las páginas de la navegación salen de `docs/docs.json`; no hay una
  segunda navegación que mantener sincronizada.
- Las imágenes, los snippets y `docs/examples/` se comparten con las páginas en inglés.

## Actualizar una traducción

1. Traduce el texto: la prosa, `title`, `description` y `sidebarTitle` del
   frontmatter, y los atributos legibles de los componentes (`title` en
   `<Card>`, `<Accordion>`, `<Tab>`, `<Step>`, y el texto de `<Note>`,
   `<Warning>`, `<Tip>`).
2. Conserva el esquema: los mismos encabezados con los mismos niveles y en el
   mismo orden, los mismos elementos `<Tab>` y `<Accordion>` en el mismo orden
   y todos los `id="..."`. El sitio asigna a un encabezado traducido el id del
   encabezado en inglés según su posición, así que los enlaces y el selector de
   idioma llevan a la misma sección. `pnpm docs:check`
   (`scripts/check-docs-translations.ts`) avisa, sin fallar, si el esquema difiere.
3. No toques el código: los bloques de código, el código en línea, los títulos
   de los bloques, las URL y los destinos de enlace con sus `#anclas` quedan
   exactamente como en la página en inglés. `pnpm docs:check` avisa, sin
   fallar, si un bloque de código difiere. Los enlaces siguen siendo relativos a la raíz de la
   documentación (`/quickstart#install`); el sitio los dirige a las páginas en español.
4. Las importaciones de snippets están una carpeta más abajo: añade un `../` al
   principio de la ruta de la importación (`./snippets/x.jsx` pasa a ser
   `../snippets/x.jsx`, y en una página anidada `../snippets/x.jsx` pasa a ser
   `../../snippets/x.jsx`).

Cuando actualices una página, alinea su estructura, su código y sus etiquetas
con la página en inglés, incluidos los cambios que el inglés haya hecho desde
entonces. Un encabezado en inglés como marcador es válido hasta que alguien lo
traduzca; si se elimina la página traducida, se muestra la inglesa. Cuando una
página en inglés se mueve o se elimina, su traducción se mueve o se elimina con
ella en el mismo cambio.

## Estilo

- Español neutro, claro y técnico, sin regionalismos. Trata al lector de **tú**
  («configura», «ejecuta»), nunca de «usted» ni con voseo.
- Usa la apertura de interrogación y exclamación (`¿ ?`, `¡ !`) y las comillas
  angulares «» para citar prosa; las comillas rectas se quedan dentro del código.
- Los títulos y encabezados llevan mayúscula solo en la primera palabra y en los
  nombres propios («Primeros pasos», no «Primeros Pasos»).
- Mantén en inglés los nombres de productos, paquetes y API: e2e, Playwright,
  `@e2e-dev/web`, MCP, CI, GitHub Actions. Mantén también las etiquetas literales
  de la CLI, como **None**, para que el lector las encuentre en el terminal.
- Para términos que no están en el glosario, usa la palabra española si es de
  uso común y deja el término inglés en cursiva solo si no hay equivalente
  establecido. No traduzcas identificadores ni nombres de opciones.
- Usa el glosario de forma coherente. Traduce la prosa de las cadenas de prompt
  exportadas, pero deja sin cambios sus comandos, código y URL. El código de los
  bloques se queda igual, incluidos los comentarios y las cadenas de prompt.
- En la tabla, cada fila es un término. Si admite varias formas (el plural, las
  conjugaciones de un verbo), van separadas por ` / ` y la primera es la
  preferida; si se mantiene en inglés, la segunda columna lo repite. Mantén la
  tabla ordenada por la primera columna. MCP, CI, SDK, CLI, API y UI se
  mantienen en inglés y no están en la tabla.

| English | Español |
| --- | --- |
| agent | agente / agentes |
| agentic | de agente / de agentes |
| API key | clave de API / claves de API |
| artifact | artefacto |
| assertion | aserción / aserciones |
| authentication | autenticación |
| blocked | bloqueado / bloqueada / bloqueados / bloqueadas |
| bug bash | bug bash |
| checkpoint | punto de control / puntos de control |
| coding agent | agente de programación / agentes de programación |
| config | configuración / configuraciones |
| configuration | configuración / configuraciones |
| continuous integration | integración continua |
| credential | credencial / credenciales |
| decision model | modelo de decisión / modelos de decisión |
| dependency | dependencia / dependencias |
| deterministic | determinista |
| device | dispositivo |
| emulator | emulador / emuladores |
| end-to-end | end-to-end |
| end-to-end testing | tests end-to-end / test end-to-end |
| endpoint | endpoint |
| engine | motor / motores |
| executor | ejecutor de pasos / ejecutores de pasos |
| fixture | fixture |
| flag | bandera / banderas |
| flaky | inestable / inestables |
| goal | objetivo / objetivos |
| harness | arnés de tests |
| headed | con interfaz (headed) / con interfaz |
| headless | sin interfaz (headless) / sin interfaz |
| hook | hook |
| hosted browser | navegador alojado / navegadores alojados |
| job | trabajo / trabajos |
| judge | juez / jueces / juzga / juzgan / juzgar |
| locator | localizador / localizadores |
| matcher | matcher |
| mobile | móvil |
| placeholder | marcador de posición / marcadores de posición |
| prompt | prompt |
| provider | proveedor / proveedores |
| pull request | pull request |
| real device | dispositivo real / dispositivos reales |
| replay | reproducción / reproducciones / reproducir / reproduce |
| replay cache | caché de reproducción |
| report | informe / informes |
| reporter | generador de informes / generadores de informes |
| retry | reintento / reintentar / reintenta |
| runner | ejecutor / ejecutores |
| schema | esquema / esquemas |
| scope | ámbito / ámbitos |
| screenshot | captura de pantalla / capturas de pantalla |
| secret | secreto / secretos |
| selector | selector / selectores |
| self-healing | autorreparación |
| semantic tree | árbol semántico / árboles semánticos |
| session | sesión / sesiones |
| setup test | test de preparación / tests de preparación |
| sign in | iniciar sesión / inicia sesión / inicies sesión / inicie sesión / inicio de sesión |
| sign out | cerrar sesión / cierra sesión / cierres sesión / cierre sesión |
| simulator | simulador / simuladores |
| skill | skill |
| snapshot | snapshot |
| step | paso / pasos |
| subscription | suscripción / suscripciones |
| target | destino / destinos |
| test | test / tests |
| test suite | suite de test / suites de test |
| timeout | tiempo de espera / tiempos de espera |
| trace | traza / trazas |
| visual testing | tests visuales / test visual |
| web | web |
| worker | worker |
