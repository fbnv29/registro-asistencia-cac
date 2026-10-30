# Netlify: preparación local y publicación manual

Política del proyecto: ningún push, pull request ni hook debe publicar. No usar
`netlify init`, Netlify Drop ni el botón de importación «Deploy» para prepararlo:
pueden iniciar el primer despliegue. No ejecutar una publicación sin autorización
explícita del usuario.

## Por qué Netlify

La aplicación ya usa una función Node.js compatible con Netlify y una interfaz
React compilada. Netlify permite servir ambas bajo el mismo origen, conservando
la protección de cookies y de solicitudes POST. Neon continúa alojando PostgreSQL.
Es la opción de menor cambio para este proyecto; no se afirma que sea la de menor
costo para cualquier carga. El consumo depende de solicitudes, tráfico, ejecución
de funciones y publicaciones, además del plan contratado.

## Tres protecciones contra publicación automática

1. Crear un proyecto vacío con `netlify sites:create`, sin subir archivos ni
   vincular Git. El repositorio de referencia es
   `fbnv29/registro-asistencia-cac`, rama `main`.
2. Mantener **Build status → Stopped builds** en Netlify. No equivale a detener
   auto publishing: Stopped builds impide también previews, ramas y build hooks.
   No crear hooks, agentes ni workflows de publicación. Si se vincula o revincula
   Git en el futuro, verificar de nuevo este ajuste: Netlify reactiva builds al
   revincular un repositorio.
3. `netlify.toml` contiene `ignore = "exit 0"` para omitir builds desde Git y un
   comando que termina con error antes de compilar. Este segundo bloqueo cubre
   hooks que ignoran la regla `ignore`. No reemplazarlo por `npm run build`.

La protección del archivo no sustituye Stopped builds. Los despliegues manuales
por CLI/API siguen siendo posibles: usarlos únicamente cuando se autorice publicar.

## Estado de la cuenta verificado el 30 de octubre de 2026

- Proyecto: [registro-asistencia-cac](https://app.netlify.com/projects/registro-asistencia-cac).
- ID: `773698ff-ef57-4d33-a124-8fbca8915618`, equipo `fbnv29` (FavLab).
- Creado vacío mediante CLI; sin despliegues ni publicación.
- Repositorio en Netlify: **Not linked**. No hay despliegue continuo que se pueda
  disparar desde GitHub. En un proyecto manual Netlify no ofrece el selector
  Stopped builds ni conserva ese ajuste sin configurar un repositorio; no se
  afirma que dicho selector esté activado. Se mantiene Git desvinculado.
- Piloto preparado con `APP_ENV=preview`, `MACA_PROVIDER=internal`, límites de
  Maca de 30/día y 6/minuto, y `CAC_PREVIEW_DATABASE_HOST` para su conexión.
- Rama Neon independiente `pilot-netlify-cac` (`br-super-scene-b6p3s9sh`), del
  proyecto `muddy-firefly-87592079`, derivada de `dev-cac-v1`. Conserva las diez
  migraciones y las claves administrativas del piloto; no es la base principal.
- Con autorización explícita del usuario, se guardó su conexión pooled como
  secreto `DATABASE_URL` en Netlify. El `.env` de desarrollo local no se modificó.
- La base principal de Neon no se migró ni se utilizará al publicar este piloto.
- Plan verificado: Free, 300 créditos por ciclo. No se activaron pagos ni recargas.

## Preparar sin desplegar

```sh
npm ci
npm test
npm run netlify:prepare
```

La última orden genera `dist/` y `artifacts/netlify/functions/api.zip`, junto con
su manifiesto. Compila y empaqueta localmente; no autentica en Netlify, no consulta
la base de datos, no migra, no carga datos y no publica. Los artefactos están
excluidos de Git. No subir la carpeta del proyecto ni `.env` como contenido web.

El adaptador `netlify/functions/api.ts` admite `/api/*` y
`/.netlify/functions/api/*`. Las redirecciones y cabeceras están en `netlify.toml`.

## Variables de la futura función

Configurar en Netlify mediante UI/CLI/API con disponibilidad para Functions (o
todos los ámbitos si el plan no permite separarlos). Las variables de
`netlify.toml` no llegan a las funciones. Nunca usar prefijo `VITE_` para secretos.

| Variable                          | Producción                                                                 | Vista previa manual                                                                   |
| --------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `APP_ENV`                         | `production`                                                               | `preview`                                                                             |
| `DATABASE_URL`                    | Conexión pooled de la base de producción                                   | Conexión pooled de una rama independiente con datos ficticios                         |
| `CAC_PREVIEW_DATABASE_HOST`       | No necesario                                                               | Host exacto de la base independiente si el contexto es deploy-preview o branch-deploy |
| `MACA_PROVIDER`                   | `internal` para iniciar sin llamadas externas; `gemini` cuando se autorice | `internal`                                                                            |
| `MACA_DAILY_LIMIT`                | `30`                                                                       | `30`                                                                                  |
| `MACA_MINUTE_LIMIT`               | `6`                                                                        | `6`                                                                                   |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Solo al habilitar Gemini; clave propia y modelo configurado                | No necesarios con proveedor interno                                                   |
| `AWS_LAMBDA_JS_RUNTIME`           | `nodejs22.x`, si se fija explícitamente en la cuenta                       | `nodejs22.x`                                                                          |

No importar el `.env` local completo a Netlify: contiene conexiones de desarrollo
y variables de administración. `DATABASE_URL_UNPOOLED`, contraseñas iniciales,
`ALLOW_DEMO_SEED`, credenciales de respaldo y conexiones de restauración no son
necesarios para la función. Las contraseñas del sistema se verifican contra los
hashes de la base, no contra variables del entorno de ejecución.

No utilizar la base de desarrollo como producción. Antes de la primera publicación,
aplicar las migraciones versionadas a la base de destino y configurar sus claves
mediante `db:passwords`, en una operación separada y autorizada. La preparación
local y Netlify nunca deben ejecutar estos comandos automáticamente.

## Primera publicación: pendiente de autorización

Mantener Stopped builds incluso para publicar manualmente. Tras comprobar el ID
del proyecto, la base de destino, sus migraciones y variables, preparar localmente.
Solo entonces, con autorización explícita:

```sh
# PUBLICA EN INTERNET: no ejecutar durante la preparación.
npx netlify-cli deploy --no-build --dir dist --functions netlify/functions --site ID_VERIFICADO --prod
```

El comando utiliza el código de funciones actual y lo empaqueta con la CLI.
Publicar solo la interfaz mediante arrastrar `dist/` no incluye esta API.
Tras publicar, verificar en HTTPS entrada, permisos, guardado, recarga, solicitudes,
traslado de asistencias, suspensiones, Excel y cierre de sesión antes de usar datos reales.

## Créditos

Según la documentación consultada el 30 de octubre de 2026, los planes por créditos
cobran 15 créditos por publicación de producción; previews y ramas no tienen ese
cargo de publicación. Las solicitudes, el tráfico y la ejecución sí pueden consumir
créditos. El plan Free tiene límite fijo y no permite auto recharge; en planes de
pago mantener desactivada esa opción si se busca evitar recargas automáticas.
Comprobar el plan real de la cuenta: los planes legacy se miden de otra forma.
No activar servicios de agentes o AI Gateway para preparar este proyecto.

## Fuentes oficiales

- [Detener builds](https://docs.netlify.com/build/configure-builds/stop-or-activate-builds/)
- [Regla ignore y su excepción para hooks](https://docs.netlify.com/build/configure-builds/ignore-builds/)
- [Variables de funciones](https://docs.netlify.com/build/functions/environment-variables/)
- [CLI deploy y --no-build](https://cli.netlify.com/commands/deploy/)
- [Créditos](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/)
