
## Instaladores de Windows y de Mac (añadido; SIN PROBAR)

No se pudieron generar aquí: el binario de Electron no se puede descargar en el entorno de desarrollo y cada
instalador se construye en su propio sistema.

Vía automática (recomendada): al subir el proyecto a GitHub, en la pestaña **Actions** elige
"Construir app de escritorio" y pulsa **Run workflow**. Al terminar, descarga los dos instaladores de la sección
"Artifacts" (`.exe` para Windows, `.dmg` para Mac). Está definido en `.github/workflows/construir-app.yml`.

Vía manual: en un PC con Windows `npm run package:win -w @tw/desktop`; en un Mac `npm run package:mac -w @tw/desktop`.

Aviso: los instaladores no están firmados. Windows mostrará "Windows protegió su PC" (Más información, Ejecutar de
todas formas). En Mac hay que abrirlo con clic derecho, Abrir. Para evitarlo hacen falta certificados de firma de
cada sistema (de pago), que no están incluidos.
