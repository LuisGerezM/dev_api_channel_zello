# Zello PTT — consola web

Consola **push-to-talk (PTT) desde el navegador** sobre la [Zello Channel API](https://github.com/zelloptt/zello-channel-api/blob/main/API.md).
Permite que un operador hable y escuche a los equipos de un canal de ZelloWork sin instalar nada: solo Chrome o Edge.

**Demo:** https://luisgerezm.github.io/mguardia-zello-ptt/

> Prueba de concepto de M-Guardia. Es un sitio 100 % estático (HTML + JS sin dependencias ni build).

---

## Funcionalidades

- Conexión a una red de ZelloWork con usuario y clave.
- Estado de los canales en tiempo real (en línea / fuera de línea, usuarios conectados).
- **PTT a todo el canal** o **privado a un usuario** dentro del canal.
- Botón PTT con mouse / táctil, o con la **barra espaciadora**.
- Recepción de audio con *jitter buffer* para que se escuche fluido.
- **Reconexión automática** ante cortes de red, con espera progresiva (1 s, 2 s, 4 s … hasta 30 s).
- Log de eventos con opción de ver el JSON crudo del protocolo (la clave aparece enmascarada).

## Requisitos

| Requisito | Detalle |
|---|---|
| Navegador | Chrome o Edge actualizados (usa WebCodecs para codificar y decodificar Opus) |
| Contexto seguro | `https://` o `http://localhost`, si no el navegador no da acceso al micrófono |
| Cuenta de ZelloWork | Una cuenta **dedicada a la consola**, miembro de cada canal con un perfil que permita hablar y escuchar |

> ⚠️ **Una cuenta = una sesión.** Si la misma cuenta se conecta en otro lado (otra pestaña, otra PC o la app), Zello desconecta la sesión anterior.

## Uso

### En línea

1. Abrir la [demo](https://luisgerezm.github.io/mguardia-zello-ptt/).
2. Completar la **red**, el **usuario**, la **clave** y los **canales** (uno por línea, con el nombre exacto que tienen en Zello).
3. **Conectar** y aceptar el permiso del micrófono.
4. Elegir un canal y **mantener apretado** el botón (o la barra espaciadora) para hablar.
   Para hablarle a un solo usuario, escribir su nombre de usuario de Zello en *Hablarle solo a*.

La red, el usuario y los canales se recuerdan en el navegador para la próxima vez. **La clave nunca se guarda.**

#### Link con datos precargados

Se puede compartir un link que ya trae la red, el usuario y los canales (nunca la clave):

```
https://luisgerezm.github.io/mguardia-zello-ptt/?network=mi-red&username=consola1&channel=Canal%20A&channel=Canal%20B
```

### En local

```bash
git clone https://github.com/LuisGerezM/mguardia-zello-ptt.git
cd mguardia-zello-ptt
python3 -m http.server 8080
```

Abrir **http://localhost:8080**. También sirve cualquier otro servidor estático (por ejemplo `npx serve`).

Para no escribir los datos cada vez, copiar la plantilla y completarla:

```bash
cp config.example.js config.local.js
```

`config.local.js` está en `.gitignore`, así que **nunca se sube**, y la página solo lo lee cuando se abre desde `localhost`.

## Estructura

```
.
├── index.html               # Página
├── css/styles.css           # Estilos
├── js/
│   ├── app.js               # Interfaz: formulario, canales, botón PTT y log
│   ├── zello-client.js      # Cliente de la Channel API: WebSocket, logon, streams, reconexión
│   ├── audio.js             # Micrófono, codec header y reproducción con jitter buffer
│   ├── pcm-tap.worklet.js   # AudioWorklet que captura el PCM del micrófono
│   └── errors.js            # Errores de Zello traducidos
├── config.example.js        # Plantilla de configuración local
└── .github/workflows/
    └── pages.yml            # Publicación en GitHub Pages
```

`ZelloClient` no depende de la interfaz: se comunica por eventos (`logged-in`, `channel-status`, `stream-start`, `disconnected`, …), así que se puede reusar en otra pantalla (por ejemplo, un mapa).

## Cómo funciona

```
 Navegador                                          Zello                 Equipos
 ┌───────────────────────────┐     WebSocket     ┌─────────┐      ┌──────────────┐
 │ Micrófono → Opus          │ ────────────────▶ │         │ ───▶ │              │
 │ Parlantes ← jitter buffer │ ◀──────────────── │  Canal  │ ◀─── │  App Zello   │
 │ Botón PTT                 │   Channel API     │         │      │              │
 └───────────────────────────┘                   └─────────┘      └──────────────┘
```

**Envío:** micrófono → `AudioWorklet` (PCM mono, 16 kHz) → `AudioEncoder` Opus a 24 kbps en paquetes de 60 ms → WebSocket.
El audio que se graba antes de que Zello confirme la transmisión se guarda en una cola y se manda después, para no perder el inicio de la frase.

**Recepción:** paquetes binarios → `AudioDecoder` → *jitter buffer* de 150 ms → parlantes.

**Reconexión:**

- El navegador avisa al instante cuando la PC se queda sin red (`offline`): la consola corta la conexión y vuelve a conectar sola cuando la red regresa (`online`).
- Ante errores temporales del servidor reintenta con espera progresiva.
- Si Zello **rechaza el logon** (credenciales, canal o permisos) **no reintenta**, para no bloquear la cuenta.

Los parámetros de audio están como constantes al principio de `js/audio.js` (`FRAME_MS`, `JITTER_S`) y `js/zello-client.js` (`OPUS_BITRATE`, `REQUEST_TIMEOUT_MS`).

## Errores comunes

| En el log | Causa probable |
|---|---|
| `invalid credentials` | Usuario o clave incorrectos para esa red |
| `channel not found … not in the contact list` | La cuenta no es miembro del canal, o el nombre del canal no es exacto |
| `not authorized` | La cuenta no tiene acceso a la API |
| `failed to start stream` | El perfil de la cuenta no tiene permiso para hablar en ese canal |
| `listen only connection` | La cuenta o su perfil en el canal es solo escucha |
| Se desconecta sola | La misma cuenta se conectó en otro lado |
| No pide el micrófono | La página no se abrió desde `https` o `localhost` |
| Aviso de WebCodecs | Navegador no compatible: usar Chrome o Edge actualizados |

## Seguridad

- El repositorio **no contiene credenciales**. La clave se escribe en el formulario, se usa solo en memoria y se envía únicamente a `wss://zellowork.io`.
- La página declara una *Content Security Policy* que solo permite cargar archivos propios del sitio y abrir conexiones a `wss://zellowork.io`.
- El workflow de despliegue publica solo los archivos de la página y falla si encuentra un `config.local.js`.

## Limitaciones conocidas

- Si el Wi-Fi sigue conectado pero se cae internet, el navegador no dispara `offline`; la desconexión se detecta recién cuando el WebSocket vence por timeout.
- La Channel API solo entrega lo que pasa **dentro de los canales**: los mensajes 1 a 1 por fuera de un canal no llegan a la consola.
- No se soportan imágenes. El envío de texto está implementado en el cliente (`sendText`), pero no se muestra en la interfaz.


## Referencias

- [Zello Channel API — especificación](https://github.com/zelloptt/zello-channel-api/blob/main/API.md)
- [WebCodecs API (MDN)](https://developer.mozilla.org/docs/Web/API/WebCodecs_API)
