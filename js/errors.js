// errors.js — Errores documentados por la Zello Channel API, traducidos.
// Spec: https://github.com/zelloptt/zello-channel-api/blob/main/API.md

export const ZELLO_ERRORS = {
  'unknown command': 'El servidor no reconoce el comando enviado.',
  'internal server error': 'Error interno del servidor de Zello.',
  'invalid json': 'JSON mal formado.',
  'invalid request': 'Formato de comando inválido.',
  'not authorized': 'Usuario, clave o token inválidos (o la cuenta no tiene acceso a la API).',
  'invalid credentials': 'Usuario o clave incorrectos para esta red de ZelloWork.',
  'channel not found': 'La cuenta no tiene ese canal en sus contactos (no es miembro, o el nombre no es exacto).',
  'not logged in': 'Se envió un comando antes de completar el logon.',
  'not enough params': 'Faltan parámetros obligatorios en el comando.',
  'server closed connection': 'Zello cerró la conexión con la red.',
  'channel is not ready': 'El canal todavía no está conectado (o no existe / sin permiso).',
  'listen only connection': 'La conexión es solo escucha: no se puede transmitir.',
  'failed to start stream': 'No se pudo iniciar la transmisión (¿permisos del rol en el canal?).',
  'failed to stop stream': 'No se pudo detener la transmisión.',
  'failed to send data': 'Error al enviar un paquete de audio.',
  'invalid audio packet': 'Paquete de audio mal formado.',
};

// Errores ante los que tiene sentido reintentar la conexión. Un rechazo del logon
// (credenciales, canal, permisos) no se arregla reintentando y puede bloquear la cuenta.
export const TRANSIENT_ERRORS = ['internal server error', 'server closed connection'];

export class ZelloError extends Error {
  constructor(code) {
    const key = String(code).split(':')[0];
    super(ZELLO_ERRORS[key] ? `${code} → ${ZELLO_ERRORS[key]}` : code);
    this.name = 'ZelloError';
    this.code = code;
  }

  get transient() {
    return TRANSIENT_ERRORS.some(t => String(this.code).startsWith(t));
  }
}

// Errores propios del cliente (no vienen de Zello): corte de conexión, timeout.
// Siempre son transitorios.
export class ConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConnectionError';
    this.transient = true;
  }
}
