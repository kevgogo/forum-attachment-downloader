# forum-attachment-downloader

[![License: CC BY-NC-SA 4.0](https://img.shields.io/badge/License-CC%20BY--NC--SA%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc-sa/4.0/)

Userscript de [Tampermonkey](https://www.tampermonkey.net/) que descarga los **adjuntos de imágenes de los hilos** de un foro XenForo (`celebforum.cc`) y los guarda **ordenados en carpetas** de tu disco: una carpeta por hilo y, dentro, una por post.

Corre dentro del navegador, con tu propia sesión iniciada. No usa servidores externos ni guarda tus credenciales.

## Qué hace

- **Estructura en disco.** Eliges una carpeta base y el script crea:

  ```
  <carpeta base>/
    <título del hilo>/
      manifest.json
      <primera línea del post 1>/   001.jpg  002.jpg  …
      <primera línea del post 2>/   001.jpg  …
  ```

  El nombre del hilo sale del título de la página y el de cada set, de la primera línea de texto del post. Las imágenes se numeran por orden de aparición.
- **Paginado.** Descarga la página actual o un rango de páginas del hilo (`1-5`, `3-5`, `4`).
- **Reanuda sin repetir.** Salta los archivos que ya existen, reintenta 3 veces cada imagen y guarda el análisis de las páginas ya leídas para no volver a pedirlas.
- **Cola de hilos.** Varios hilos pendientes se procesan **de uno en uno**, aunque tengas varias pestañas abiertas. Puedes reordenar, cancelar, pausar ("pausar este y pasar al siguiente" o "pausar todo") y continuar solo con la cola al terminar.
- **Persistencia.** La cola, el progreso y el análisis sobreviven a recargar la página o cerrar el navegador (localStorage e IndexedDB). Se pueden **exportar e importar** a un archivo `.json`.
- **`manifest.json` por hilo.** Registra cada set, cada archivo (URL de origen y estado `ok` o `failed`) y el avance (`in_progress`, `paused`, `stopped`, `complete`, `complete_with_failures`).
- **Verificaciones del sitio.** Si el foro o Cloudflare piden un captcha, el script **se pausa y te avisa** con un enlace. Lo resuelves tú y continúa solo. No intenta saltarse ni resolver nada.
- **Panel en pantalla.** Muestra la cola con su orden, el progreso y los totales de imágenes por hilo y en general. Fuera de un hilo (por ejemplo, la portada) la pestaña funciona como **gestor de la cola**.

## Requisitos

- Un navegador basado en Chromium (Edge o Chrome), por la API de acceso a carpetas (`showDirectoryPicker`).
- Tampermonkey con el permiso **"Permitir scripts de usuario"** activado en la página de extensiones del navegador.
- Tener la sesión iniciada en el foro.

## Instalación

1. Instala Tampermonkey.
2. Abre la URL del script en bruto: <https://raw.githubusercontent.com/kevgogo/forum-attachment-downloader/main/celebforum-downloader.user.js> y acepta la instalación.
3. El script se **actualiza solo** cuando se publica una versión nueva (`@updateURL`). Para forzarlo: panel de Tampermonkey, Utilidades y "Buscar actualizaciones de scripts de usuario". Después, recarga las pestañas del foro.

## Uso

1. Abre un hilo. Abajo a la derecha aparecen los botones.
2. **Descargar página N** baja los adjuntos de la página actual. **Descargar hilo completo** pide el rango de páginas.
3. La primera vez eliges la carpeta base y aceptas el permiso de escritura.
4. Si se corta, vuelve al hilo y pulsa **Reanudar descarga**, o usa **Procesar cola guardada** desde cualquier página del foro.

Opciones (casillas en el panel):

| Opción | Por defecto | Efecto |
|---|---|---|
| Continuar con la cola guardada al terminar | Activada | Al acabar un hilo, sigue con los pendientes. |
| Reanudar solo al abrir un hilo pendiente | Desactivada | Reanuda al cargar la página si el navegador conserva el permiso de la carpeta. |
| Retomar primero el de menos páginas | Desactivada | Ordena la cola de menos a más páginas. |

## Limitaciones

- Está hecho para la estructura de XenForo de `celebforum.cc` (`.bbWrapper`, `article.message`, enlaces `/attachments/`). Si el sitio cambia su HTML, puede dejar de encontrar adjuntos.
- Los archivos se guardan siempre con extensión `.jpg`, aunque la imagen original sea de otro formato.
- La descarga corre en la pestaña: si la cierras, se detiene (queda pendiente y se retoma después). Si el equipo se suspende o se apaga, también se detiene.
- Las carpetas base recordadas son permisos del navegador: no se pueden exportar y puede que haya que aceptarlas de nuevo.
- Un análisis de páginas guardado dura 3 días. Pasado ese tiempo, se vuelve a leer el hilo.

## Uso responsable

Úsalo solo con contenido al que tengas acceso legítimo y respetando los términos del sitio. Las verificaciones y captchas están para que las resuelva una persona, y el script no las evita.

## Licencia

Copyright (c) 2026 kevgogo. Distribuido bajo [Creative Commons Atribución-NoComercial-CompartirIgual 4.0 Internacional (CC BY-NC-SA 4.0)](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.es). Texto completo en [`LICENSE`](LICENSE).

En resumen:

- Puedes **copiar, usar y modificar** el script, dando crédito a su autor.
- **No** puedes usarlo con fines comerciales.
- Si lo modificas o lo redistribuyes, debes hacerlo bajo **esta misma licencia**.

## Versiones y actualizaciones

El campo `@version` debe **aumentar** en cada cambio que quieras que Tampermonkey detecte. Formato usado: `AAAA.MM.DD.N`.
