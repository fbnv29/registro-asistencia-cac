# Registro de Asistencia CAC

Aplicación interna del Centro Artístico CAC: portada de libros, asistencia semanal individual, horarios con vigencia, matrículas, suspensiones administrativas y reportes Excel.

**Estado:** primera versión implementada y verificada localmente con datos ficticios. Los despliegues están pospuestos por decisión del usuario. La base principal no se ha migrado ni cargado con estudiantes.

## Desarrollo local

Requiere Node.js 22.12 o posterior y una rama de desarrollo de Neon PostgreSQL.

```sh
npm ci
cp .env.example .env
# Completar las conexiones de la rama de desarrollo y las contraseñas de configuración.
npm run db:migrate
npm run db:passwords
npm run dev
```

Abrir `http://127.0.0.1:5173`. `npm run dev` sirve React y la API en el mismo origen. No hace falta la CLI de Netlify para desarrollar.

- `DATABASE_URL`: conexión **pooled** de la rama seleccionada.
- `DATABASE_URL_UNPOOLED`: conexión **directa**, únicamente para migraciones.
- `APP_ENV`: `development`, `preview` o `production`.
- `CAC_ADMIN_PASSWORD`: contraseña administrativa inicial de al menos seis caracteres. `db:passwords` la convierte en un hash. La credencial independiente de creación de libros dejó de utilizarse. El servidor usa los hashes de PostgreSQL, no estas variables.
- El archivo `.env` está excluido de Git. Ninguna variable del servidor lleva prefijo `VITE_`.

La rama utilizada en esta implementación es `dev-cac-v1`, del proyecto Neon `registro-asistencia-cac`. La rama principal permanece separada.

### Datos de demostración

Solo en una base de desarrollo o vista previa, establecer `APP_ENV=development` (o `preview`), `ALLOW_DEMO_SEED=true` y `CAC_DEMO_BOOK_PASSWORD`, además de las contraseñas de configuración. Ejecutar:

```sh
npm run db:seed
```

Crea dos profesores ficticios, tres libros y 68 matrículas: Teclado y Sensibilización musical tienen 30 estudiantes cada uno; Ensamble, ocho. Hay ingresos tardíos, retiros, asistencia de ejemplo en octubre y un receso de Fiestas Patrias. Todos los libros de ejemplo usan la contraseña local `CAC_DEMO_BOOK_PASSWORD`. Si ya hay libros, el script no agrega otra demostración.

No hay contraseñas predeterminadas en el repositorio. Las de esta sesión están únicamente en el `.env` local y como hashes en la rama de desarrollo.

## Uso

1. Administración ingresa con la contraseña administrativa y agrega profesores y períodos lectivos.
2. Administración crea los libros: selecciona profesor y período, escribe la disciplina y el número de sesiones semanales, y define la contraseña del libro. Un profesor con acceso a un libro puede proponer otro para su misma disciplina docente desde Solicitudes; administración debe aprobar su creación.
3. Dentro del libro el profesor propone estudiantes: nombre completo, ingreso y día/hora de cada sesión. El registro aparece después de la aprobación administrativa. Administración también puede registrar estudiantes directamente. La duración parte en 45 minutos y administración puede ajustarla por libro.
4. La hoja **Asistencia** muestra estudiantes en filas y semanas de lunes a domingo en columnas. Cada sesión muestra su fecha real. Los cambios se guardan al elegir estado; los fallos muestran **Reintentar**.
5. **Horario** muestra la distribución recurrente vigente en una fecha. Sus cambios conservan el pasado. Si un cambio dejaría marcas existentes fuera de horario, el servidor pide otra fecha o retirar esas marcas explícitamente antes de continuar.
6. **Estudiantes** permite proponer correcciones de nombre y retiros; solo administración puede confirmarlos o aplicarlos directamente. El ingreso original se conserva. Un reemplazante se registra como estudiante independiente.
7. Administración suspende fechas o intervalos, inclusive ambos extremos, para el CAC, un profesor con todos sus libros o un libro. Puede quitar una suspensión y recuperar las marcas subyacentes.
8. **Resumen** filtra por fechas y exporta un `.xlsx` con resumen por estudiante, total del libro y detalle de sesiones. El total del libro se pondera por sesiones, no por promedio de porcentajes individuales.

### Regla de cálculo

`(presentes + faltas justificadas) / (presentes + faltas justificadas + ausentes) × 100`

Pendientes y suspendidas se excluyen. Sin sesiones computables se muestra **Sin registros**. Las suspensiones superpuestas no duplican sesiones. Solo se generan sesiones dentro del período y de las fechas de matrícula. El último día de matrícula es inclusivo. No se convierten pendientes en ausencias automáticamente y no hay cierres de período.

Las fechas se manejan como fechas locales; la semana actual usa `America/Santiago`. Si un horario cambia a mitad de semana, la cuadrícula conserva todas las fechas efectivas de esa semana en la casilla correspondiente.

## Arquitectura y API

- React + TypeScript + Vite para la interfaz.
- Función Node.js en Netlify para la API; el servidor local adapta el mismo manejador.
- Driver `@neondatabase/serverless` con WebSocket y transacciones PostgreSQL.
- Migraciones SQL versionadas; el ejecutor usa un bloqueo para evitar ejecuciones simultáneas.
- Sesiones fechadas derivadas del calendario y de versiones del horario. Al registrar una marca, se materializa la sesión en `lessons`; la restricción `(enrollment_id, date, slot)` impide duplicados. Lectura, validación y Excel usan el mismo generador de fechas.
- Las operaciones concurrentes de asistencia, horario y suspensión bloquean los libros afectados dentro de una transacción.

| Ruta bajo `/api`                                      | Función                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /catalog`                                        | Portada pública: libros, profesores y períodos, sin estudiantes ni contraseñas |
| `GET /session`, `POST /login`, `POST /logout`         | Acceso y sesión                                                                |
| `POST /books`                                         | Crear libro exclusivamente con acceso administrativo                           |
| `GET /books/:id`                                      | Matrículas, horarios, asistencia y suspensiones del libro autorizado           |
| `POST /books/:id/students`                            | Proponer matrícula o actualización; respuesta 202                              |
| `POST /books/:id/schedule`                            | Proponer horario con fecha de vigencia; respuesta 202                          |
| `POST /books/:id/attendance`                          | Marcar o devolver a pendiente una sesión                                       |
| `GET /books/:id/export?from=AAAA-MM-DD&to=AAAA-MM-DD` | Descargar Excel autorizado                                                     |
| `GET /admin`, `POST /admin`                           | Gestión administrativa                                                         |

Las contraseñas usan scrypt con sal aleatoria. Las cookies de sesión son HttpOnly, SameSite=Strict y Secure bajo HTTPS; vencen a las 12 horas. PostgreSQL guarda únicamente el hash del token de sesión. Hay validación de origen en escrituras, autorización por libro en cada operación, consultas parametrizadas y límites de intentos persistidos por IP y destino. Restablecer una contraseña revoca las sesiones correspondientes. La bitácora registra fecha, tipo de acceso y cambios, pero no identifica personas porque las contraseñas se comparten.

## Validación

```sh
npm test
npm run build
npm audit
# Solo sobre una rama de desarrollo configurada:
RUN_INTEGRATION=true npm run test:integration
```

Las pruebas de integración crean sus propios registros con UUID y eliminan únicamente sus fixtures. Requieren las contraseñas administrativas locales ya configuradas. Cubren autorización, supercontraseña, persistencia y corrección, suspensiones superpuestas y restauración, matrículas tardías y retiros, horarios, Excel, límite de intentos y revocación de sesiones.

GitHub Actions ejecuta las pruebas sin conexión a datos y la compilación en pushes y pull requests. No despliega automáticamente.

## Publicación futura en Netlify

La configuración está en `netlify.toml`: construcción `npm run build`, salida `dist`, API en `netlify/functions/api.ts`. La ruta `/api/*` se redirige a la función y el resto a la aplicación.

1. Conectar el repositorio en Netlify cuando se decida publicar. No habilitar un plan de pago para este piloto.
2. Para una vista previa, usar una rama de Neon dedicada con datos ficticios, `APP_ENV=preview`, y su `DATABASE_URL` como variable **de funciones**. No compartir secretos de producción con vistas previas.
3. En los contextos `deploy-preview` y `branch-deploy`, configurar además `CAC_PREVIEW_DATABASE_HOST` con el hostname exacto de esa conexión. El servidor bloquea estos contextos si falta esta configuración independiente.
4. Para producción, aplicar las migraciones y configurar contraseñas sobre la base principal mediante las conexiones correspondientes. La compilación web no ejecuta migraciones ni carga datos.
5. Verificar entrada, guardado, recarga, suspensión, exportación y salida en el sitio HTTPS antes de utilizar datos reales.

GitHub Pages puede publicar una maqueta estática, pero no ejecuta esta API ni protege el acceso compartido a Neon. Esta versión conserva el servidor para que la asistencia sea persistente y compartida.

## Panel administrativo ampliado

Administración abre por defecto una vista global de asistencia por período y rango de fechas, con totales ponderados por sesión y detalle por curso. Las secciones Horarios y Estudiantes tienen pestañas por libro; desde allí se pueden agregar estudiantes, editar sus nombres y horarios y registrar o quitar retiros.

Solo administración puede establecer una fecha de retiro o ver las fichas y registros de estudiantes retirados, también al consultar o exportar períodos anteriores. La API filtra fichas, horarios y asistencias antes de entregarlos a una sesión de libro. Un retiro se aplica desde su fecha; la última fecha sigue siendo computable en el historial administrativo. No se borran datos ni se transfieren marcas al reemplazante. Los horarios de retirados aparecen disponibles cuando ningún estudiante activo ocupa el mismo día y hora; un reemplazo deja de mostrar ese horario como disponible. No se ha definido un aforo máximo por curso.

`GET /api/admin/overview` entrega los datos de todos los libros exclusivamente con una sesión administrativa. Las pruebas comprueban la restricción de retiro, la no exposición de datos a profesores y la liberación y ocupación de horarios.

## Solicitudes y aprobación administrativa

Los profesores registran y corrigen asistencia directamente. Las altas y modificaciones de estudiantes, retiros y horarios se envían como solicitudes; no alteran el libro mientras están pendientes. La hoja Solicitudes permite consultar estados y observaciones, proponer nuevos libros y actualizar el libro después de una aprobación. Los horarios también se pueden proponer desde cada estudiante o su tarjeta en la hoja Horario.

Administración dispone de Pendientes por aprobar, con propuestas, datos anteriores, observaciones y botones Aprobar y aplicar / Rechazar. Aprobar valida otra vez y aplica el cambio en la misma transacción que marca la solicitud como aprobada. Rechazar conserva los datos vigentes. Una propuesta obsoleta no puede sobrescribir cambios administrativos posteriores; debe rechazarse y enviarse actualizada. Las solicitudes idénticas pendientes se deduplican y una solicitud revisada no puede aplicarse dos veces. La contraseña de un libro propuesto se guarda como hash y nunca aparece en las listas de solicitudes.

La migración `002_change_requests.sql` agrega la bandeja y los estados. El código de validación de cambios es compartido entre las operaciones administrativas directas y las aprobaciones. Las propuestas se validan en un savepoint que se revierte antes de guardar la solicitud; no se confirma ningún cambio provisional en estudiantes, libros ni horarios.

- `GET /api/books/:id/requests`: solicitudes del libro autorizado.
- `POST /api/books/:id/requests`: propuesta de estudiante, ficha/retiro, horario o libro; respuesta 202.
- Las rutas existentes de modificación de estudiantes y horarios también devuelven 202 y crean una solicitud también con una sesión administrativa cuando se usan desde el libro.
- `GET /api/admin/requests`: bandeja e historial administrativos.
- `POST /api/admin/requests/:id`: decisión `approve` o `reject`, con observación opcional.
- `POST /api/books`: creación administrativa directa; un acceso de profesor o la antigua credencial de creación reciben 403.

Los profesores solo pueden proponer cambios en el libro al que tienen acceso y libros nuevos para el profesor asociado a él. El historial administrativo de estudiantes retirados sigue restringido a administración. Las pruebas de integración verifican propuestas sin aplicación prematura, aprobación, rechazo, conflictos, deduplicación, permisos y contraseñas protegidas.

## Notas, horarios y calendario automático

El botón Crear libro se encuentra exclusivamente en Administración. Dentro de un libro, las modificaciones de estudiantes y horarios siempre quedan pendientes de aprobación, incluso con una sesión administrativa. Las ediciones directas se realizan desde las secciones administrativas mediante `POST /api/admin/books/:id/students` y `POST /api/admin/books/:id/schedule`.

La asistencia y las notas breves por estudiante se guardan directamente. `POST /api/books/:id/notes` permite una nota de hasta 500 caracteres y registra el cambio en la bitácora. Cambiar una nota no invalida una propuesta pendiente sobre la ficha. La migración `003_student_notes_and_holiday_exceptions.sql` agrega estas notas y las excepciones del calendario.

Las altas, cambios de horario y reactivaciones validan las sesiones fechadas contra las del mismo libro, considerando duración, matrícula y vigencias. Se rechazan tanto coincidencias exactas como cruces parciales, también al aprobar una propuesta. Los horarios contiguos se permiten. Los horarios históricos coincidentes anteriores a esta validación se conservan.

Los feriados nacionales de Chile se generan por año con `date-holidays`, sin llamadas externas durante el uso. Se corrige su regla de Pascua para incluir Viernes y Sábado Santo, según el [calendario oficial 2026](https://www.gob.cl/noticias/feriados-2026-revisa-cuantos-habra-y-cuales-son-irrenunciables/). Los feriados regionales, vacaciones y cierres especiales se ingresan como suspensiones administrativas. Las reglas deben revisarse al actualizar la dependencia o ante feriados extraordinarios.

La tabla de suspensiones distingue cierres manuales y feriados automáticos. Administración puede habilitar clases en un feriado y restaurarlo después; esa excepción solo desactiva el feriado automático, no otras suspensiones superpuestas. Los feriados se excluyen de porcentajes y exportaciones igual que las demás suspensiones y conservan las marcas anteriores. La tabla de profesores muestra las disciplinas/libros y sus períodos.

## Cierre del piloto: archivo, revisiones y recuperación

La migración `004_archive_and_revisions.sql` conserva los datos y agrega archivo de entidades y revisiones. Los libros anteriores comienzan activos. Las asistencias existentes parten en revisión 1; las sesiones sin marcas y las notas comienzan en 0. Volver una asistencia a pendiente conserva su revisión en `lessons`.

Administración dispone de **Editar y archivar** para corregir profesores, períodos y libros, y para archivar/restaurar sin borrar. Los cambios de fechas se rechazan si dejan matrículas, horarios o asistencias fuera del período. Disciplina y profesor se pueden corregir; el período del libro y las sesiones semanales se conservan. Cambiar la duración valida cruces parciales, sesiones contiguas y medianoche contra el calendario completo, antes de guardar.

Archivar un profesor lo excluye de nuevas asignaciones; sus libros siguen funcionando. Archivar un libro o período bloquea cambios de asistencia, notas, matrículas, horarios, duración y aprobación de solicitudes, también para administración. Las solicitudes se conservan y pueden rechazarse. Restaurar vuelve a permitir escritura siempre que el período y el libro estén activos. La portada separa **Libros activos** y **Archivo**; los profesores conservan acceso protegido de consulta y exportación, con las restricciones anteriores de alumnos retirados.

### Contratos de API

- `POST /api/admin`: nuevas acciones `edit-teacher` (`id`, `name`), `edit-period` (`id`, `name`, `start_date`, `end_date`), `edit-book` (`id`, `discipline`, `teacher_id`), `archive` (`entity`: `teacher|period|book`, `id`, `archived`: boolean). Requieren administración. La acción `duration` ahora comprueba conflictos antes de modificar el libro.
- Los catálogos incorporan `archived_at` y `period_archived_at` para libros; la lectura del libro incluye `can_write`, `note_revision` en matrículas y `revision` en registros de asistencia, incluidos los pendientes materializados.
- Asistencia y notas exigen `expected_revision`. Un conflicto devuelve HTTP 409, `code: REVISION_CONFLICT` y `current` con revisión y dato vigente. El cliente permite conservar el dato o reenviar la intención con la revisión leída; no existe sobrescritura forzada. `resolve_conflict: true` identifica en la bitácora una resolución explícita, sujeta a la misma validación.
- Sesión vencida: HTTP 401 / `SESSION_EXPIRED`; permisos: HTTP 403 / `FORBIDDEN`; archivo: HTTP 409 / `ARCHIVED`; validación: `VALIDATION_ERROR`. Los fallos internos incluyen un `error_id` y el registro técnico contiene solo identificador, ruta sin UUID y código, sin fichas ni credenciales.

La pantalla actualiza al recuperar foco y cada 30 segundos mientras está visible. Los intentos fallidos se conservan en memoria con su revisión original; no se escriben fichas ni borradores en almacenamiento del navegador. El reingreso conserva el cambio y vuelve a validar permisos y revisión. Se advierte antes de cerrar, recargar o cambiar de sección con cambios pendientes. Cerrar definitivamente el navegador descarta los borradores: no hay modo de trabajo sin conexión.

### Respaldar y comprobar recuperación

Se requieren las utilidades oficiales PostgreSQL `pg_dump` y `pg_restore` compatibles con el servidor. Se buscan en `PG_BIN`, en `/opt/homebrew/opt/libpq/bin` si existe, o en PATH. La conexión es siempre directa. Los archivos se crean con permisos privados y están excluidos de Git; no deben subirse a repositorios ni adjuntarse a incidencias.

```sh
npm run db:backup -- /ruta/privada/cac.dump
# Definir CAC_RESTORE_DATABASE_URL en el entorno, nunca en un comando compartido.
# Debe apuntar a una base VACÍA cac_restore_check_* creada en la rama de desarrollo.
npm run db:restore:test -- /ruta/privada/cac.dump
```

El script de restauración exige `APP_ENV=development|preview`, el mismo servidor que la conexión de desarrollo y una base distinta cuyo nombre comienza por `cac_restore_check_`. No borra objetos existentes ni ejecuta `--clean`; restaura en una sola transacción y se detiene al fallar. Comparar después migraciones, filas relevantes y un recorrido de acceso/consulta. Retener temporalmente el destino para revisión y eliminarlo cuando ya no se necesite.

Se comprobó respaldo y restauración en `cac_restore_check_20261029`, únicamente en la rama de desarrollo, verificando las cuatro migraciones y registros de libros, matrículas, sesiones y asistencias. Este ensayo no configura una política automática de respaldos de producción.

### Verificación local y publicación pendiente

```sh
npm test
npm run build
RUN_INTEGRATION=true npm run test:integration
# Con npm run dev activo en otro terminal y Chromium instalado:
npx playwright install chromium
npm run test:e2e
```

Las pruebas de navegador crean y limpian sus propios registros ficticios. Cubren propuesta/aprobación, notas, asistencia persistente, desconexión y reintento, conflicto entre clientes, sesión vencida, archivo, consulta/exportación y navegación por teclado en 390 px. No se ejecutan con datos de producción ni se despliega desde estas pruebas.

Antes de publicar: aplicar migraciones a la base de destino, configurar variables del servidor y contraseñas definitivas mediante `db:passwords` y el panel, confirmar separación entre producción y vistas previas, verificar cookies Secure/HttpOnly en HTTPS, guardado/recarga/exportación en Netlify y configurar retención y recuperación de respaldos según los servicios contratados. `123456` se mantiene solo en el entorno local de este piloto. Validar facilidad de uso con profesores reales durante el piloto.

## 🤖 Maca Asistente

El panel administrativo incorpora análisis institucional de solo lectura, con interpretación opcional mediante Groq o Gemini y respaldo interno y protección de datos personales. Configuración, uso, seguridad, migraciones y pruebas: [guía de Maca](docs/MACA.md).
