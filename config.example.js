// config.example.js — Plantilla de configuración para desarrollo local.
//
// Copiar a config.local.js y completar. config.local.js está en .gitignore: NUNCA se sube al repo.
// Solo se carga cuando la página se abre desde localhost; en el sitio publicado los datos
// se cargan desde el formulario.
window.ZELLO_CONFIG = {
  network: '',   // red de ZelloWork (el "xxx" de https://xxx.zellowork.com)
  username: '',  // cuenta reservada para la consola web
  password: '',
  channels: [
    // nombres EXACTOS de los canales, tal como aparecen en la consola de Zello
    // 'Canal de prueba',
  ],
};
