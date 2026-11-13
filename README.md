# Esee Visor

Mirá las cámaras de un DVR/NVR chino de los que usan la app **EseeCloud** (firmware Juan / dvr163, por ejemplo el K8210-3WS) desde la tele, el celular o la PC, dentro de tu red de casa y sin pasar por la nube.

Estos equipos no ofrecen RTSP ni ONVIF: solo hablan un protocolo propio ("kp2p") por WebSocket en el puerto 10000. Esee Visor es un servidor chico en Node.js que habla ese protocolo, convierte el video H.264 a MP4 fragmentado y lo muestra en una página web.

## Qué hace

- Grilla con todas las cámaras en vivo.
- Cámara a pantalla completa, en calidad baja o alta (HD).
- Movimiento (PTZ) y zoom, con botones en pantalla, teclado o control remoto.
- Velocidad PTZ ajustable por cámara desde el engranaje; el ajuste se comparte entre los dispositivos conectados al visor.
- Sonido en vivo de la cámara y botón para hablar por su parlante (requiere HTTPS).
- Grabaciones del disco del DVR: línea de tiempo por día con los tramos de movimiento marcados, salto entre eventos, velocidad y zoom de la línea de tiempo.
- Descarga de un tramo (marcar inicio y fin): al tocar "Descargar tramo" se elige de qué cámaras bajar ese mismo tramo. Con una cámara baja un `.mp4`; con varias, un solo `.zip` con un `.mp4` por cámara (útil cuando un evento lo toman varias cámaras).
- Elegir qué cámaras se ven en la grilla (botón "▦ Cámaras" arriba a la derecha): de una sola hasta todas. Se guarda en cada dispositivo, así el Fire TV puede mostrar todas y el iPhone unas pocas; mostrar menos también baja la carga del DVR.
- Imagen flotante (PiP) donde el navegador lo permite.
- Se actualiza solo: el servidor baja las versiones nuevas desde GitHub y las pantallas abiertas se recargan.
- Sin dependencias: solo hace falta Node.js 22 o más nuevo.

## Instalación

Hace falta una computadora que quede encendida en la misma red que el DVR.

1. Instalá [Node.js](https://nodejs.org) y [Git](https://git-scm.com).
2. Cloná este repositorio.
3. Copiá `config.example.json` como `config.json` y completá la IP, el usuario y la clave del DVR. Ese archivo no se sube nunca a GitHub.
4. Ajustá `cameras.json` con los canales que tengas conectados (los canales empiezan en 0).
5. Ejecutá `iniciar.bat`. Muestra la dirección para abrir, por ejemplo `http://192.168.0.50:8080`.

### Dejarlo corriendo sin ventana

Cerrá `iniciar.bat` y ejecutá `instalar-inicio.bat` una vez: el servidor queda corriendo oculto y arranca solo cada vez que iniciás sesión en Windows. Lo que imprime queda en `servidor.log`. Con `detener.bat` se detiene y con `quitar-inicio.bat` deja de arrancar solo.

### Que arranque al encender la PC (sin iniciar sesión)

Ejecutá `instalar-servicio.bat`. Pide permiso de administrador y la clave de Windows del usuario, y crea una tarea programada ("EseeVisor") que arranca con la PC, aunque nadie inicie sesión. Reemplaza al arranque de `instalar-inicio.bat`. Se quita con `quitar-servicio.bat`. Después de `detener.bat`, vuelve a arrancar con `schtasks /Run /TN EseeVisor` o reiniciando la PC.

## Uso

Abrí esa dirección en el navegador del dispositivo.

- **Amazon Fire TV**: con el navegador Silk. Guardala en favoritos.
- **iPhone / iPad**: en Safari, Compartir → "Agregar a inicio" para tenerla como app a pantalla completa.
  - El ícono abre como app a pantalla completa. iOS no permite la imagen flotante (PiP) en ese modo; para usar PiP, tocá el botón **PiP** cuatro veces seguidas y la cámara se abre en Safari (ahí sí anda PiP). Si preferís tener siempre Safari, agregá a inicio la dirección terminada en `/safari`.

| Tecla / control | En la grilla | En una cámara |
|---|---|---|
| Flechas | Elegir cámara | Mover la cámara |
| OK / Enter | Abrir | Cambiar calidad baja / HD |
| + / − (o avance / retroceso) | — | Zoom |
| 1 a 9 | Abrir esa cámara | Cambiar a esa cámara |
| Atrás / Esc | — | Volver a la grilla |

## PIN de acceso

Agregá `"pin": "1234"` (el número que quieras) en `config.json` y reiniciá el servidor. Cada dispositivo lo pide una sola vez.

## Entrar con Face ID (o huella)

Con un PIN configurado, cada dispositivo puede registrar una llave de acceso y entrar con Face ID en vez del PIN. El navegador solo lo permite en páginas HTTPS con nombre, no por IP. La forma simple es Tailscale:

1. Instalá [Tailscale](https://tailscale.com/download) en la computadora del servidor y en el teléfono, con la misma cuenta.
2. En la computadora del servidor ejecutá `tailscale serve --bg 8080`. Si HTTPS no está habilitado en tu red de Tailscale, el comando muestra un enlace para activarlo. Al terminar informa la dirección, del tipo `https://nombre-pc.tu-red.ts.net`.
3. Abrí esa dirección en el teléfono, entrá con el PIN y tocá **Activar Face ID**.
4. En iPhone: Compartir → "Agregar a inicio". Desde ese ícono la app pide la cara al abrir y vuelve a pedirla tras 5 minutos fuera.

Las llaves registradas se guardan en `passkeys.json` (no se sube a GitHub). Para dar de baja un dispositivo, borrá su entrada de ese archivo y reiniciá.

## Seguridad

- Sin PIN, cualquiera conectado a tu red puede ver y mover las cámaras desde la página.
- No abras el puerto 8080 a internet. Para ver las cámaras desde afuera usá una VPN (por ejemplo Tailscale o WireGuard).

## Archivos

- `server.js`: servidor web y manejo de canales.
- `lib/kp2p.js`: cliente del protocolo del DVR.
- `lib/fmp4.js`: empaquetador de H.264 a MP4 fragmentado.
- `public/index.html`: la página del visor.
- `lib/recordings.js`: búsqueda y reproducción de grabaciones.
- `tools/probe.js`: diagnóstico; conecta, lista códec y resolución por canal y guarda unos segundos de video.

## Botón para abrir la reja o el portón (eWeLink)

Permite poner en la cámara que elijas un botón que acciona un dispositivo eWeLink (Sonoff y compatibles). Se configura desde la app y se puede cambiar de cámara cuando quieras.

Requisitos: tener un PIN configurado y HTTPS (Tailscale).

1. Creá la aplicación de desarrollador en [dev.ewelink.cc](https://dev.ewelink.cc). Como **dirección de redirección** poné la que muestra la app en Ajustes de cámara → "Botón para abrir" (algo como `https://tu-equipo.ts.net/ewelink/callback`).
2. Pegá el **APPID** y el **APP SECRET** en el archivo `ewelink.json` del servidor y reiniciá.
3. En la app, entrá a una cámara → ⚙ (Ajustes) → "Conectar ahora" e iniciá sesión en eWeLink (hacelo desde la PC del servidor).

La sincronización recorre todos tus "hogares" de eWeLink, así aparecen tus propios dispositivos aunque estén en distintos hogares. Si alguno igual no se lista (por ejemplo, marcas que la API no autoriza), agregá su ID de dispositivo a `includeDeviceIds` en `ewelink.json` para traerlo por ID. Los ID se obtienen en eWeLink → Ajustes del dispositivo → Información del dispositivo.
4. En cualquier cámara, ⚙ → elegí el dispositivo, el texto del botón y qué hace (pulso / alternar / encender / apagar) → **Guardar botón**. Aparece en esa cámara.

Para moverlo a otra cámara: en la cámara vieja ⚙ → **Quitar**; en la nueva ⚙ → elegí el dispositivo → Guardar. El botón pide un segundo toque antes de accionar, para no abrir por accidente. El control va primero por tu red local y, si falla, por la nube de eWeLink.

## Limitaciones conocidas

- El sonido de las grabaciones solo se escucha a velocidad 1x.
- La velocidad rápida de grabaciones depende de lo que entregue el DVR (en la práctica, unas 2 o 3 veces el tiempo real).
- La hora impresa en la imagen puede diferir unos segundos de la línea de tiempo: son relojes distintos (cámara y DVR).
- Hablar por el parlante solo aparece en páginas HTTPS (el navegador no da el micrófono de otra forma) y es de una vía por vez: mientras la cámara reproduce tu voz, silencia su propio micrófono. Si el sonido saliera con ruido, se puede probar otro formato agregando `"talkFormat": "V2"` (o `V3`, `V4`) en `cameras.json`.
- Las luces (infrarrojo y LED blanco) no se pueden manejar: el DVR acepta el ajuste `ModeSetting.IRCutFilterMode` pero no lo reenvía a las cámaras, y `ledPwm` vuelve vacío.
- Solo H.264. Las cámaras que transmitan en H.265 no se ven.
- En iPhone anterior a iOS 17.1 se usa HLS, con unos segundos de demora.
