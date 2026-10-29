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
- `CAC_ADMIN_PASSWORD` y `CAC_CREATOR_PASSWORD`: contraseñas iniciales distintas, de al menos seis caracteres. `db:passwords` las convierte en hashes. El servidor usa los hashes de PostgreSQL, no estas variables.
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
2. El profesor usa la contraseña de creación para abrir un libro: selecciona su nombre y período, escribe la disciplina y el número de sesiones semanales, y define la contraseña del libro.
3. Dentro del libro registra estudiantes: nombre completo, ingreso y día/hora de cada sesión. La duración parte en 45 minutos y administración puede ajustarla por libro.
4. La hoja **Asistencia** muestra estudiantes en filas y semanas de lunes a domingo en columnas. Cada sesión muestra su fecha real. Los cambios se guardan al elegir estado; los fallos muestran **Reintentar**.
5. **Horario** muestra la distribución recurrente vigente en una fecha. Sus cambios conservan el pasado. Si un cambio dejaría marcas existentes fuera de horario, el servidor pide otra fecha o retirar esas marcas explícitamente antes de continuar.
6. **Estudiantes** permite corregir el nombre; solo administración puede fijar o quitar la fecha de retiro. El ingreso original se conserva. Un reemplazante se registra como estudiante independiente.
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
| `POST /books`                                         | Crear libro con acceso de creación o administración                            |
| `GET /books/:id`                                      | Matrículas, horarios, asistencia y suspensiones del libro autorizado           |
| `POST /books/:id/students`                            | Crear matrícula o actualizar nombre/retiro                                     |
| `POST /books/:id/schedule`                            | Horario con fecha de vigencia                                                  |
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
