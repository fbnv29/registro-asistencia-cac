# Maca Asistente

Implementación sobre la arquitectura existente: React 19 + Vite + TypeScript, función Netlify `api`, PostgreSQL con `@neondatabase/serverless` por WebSocket. No se migró a Next.js. La configuración conecta directamente mediante `DATABASE_URL` a Neon; el código no integra el aprovisionamiento de Netlify Database. El origen de la facturación debe confirmarse en las cuentas del propietario.

## Uso

Administración → 🤖 Maca Asistente. Preguntar por asistencia, profesores con registros, pendientes, suspensiones, solicitudes de horario, superposiciones o evolución mensual. Seleccionar libro/profesor para filtrar; los nombres escritos en el chat no actúan como filtros. Fechas explícitas ISO, meses en español, hoy, ayer, semana, mes y semestre se resuelven en el servidor. Los selectores de fecha prevalecen. El semestre corresponde a enero–junio o julio–diciembre; el período lectivo de cada libro limita las sesiones.

Las conversaciones existen únicamente en memoria del componente (hasta 20 intercambios); desaparecen al salir de la pestaña o recargar. No se envía historial a Gemini. Las preguntas son independientes: repetir período y filtros cuando corresponda.

Una sesión es una clase individual de un estudiante. Una marca de ausencia acredita un registro, no que una clase se haya realizado físicamente. El conteo de profesores identifica libros con marcas, no al autor material de las marcas. La cola de cambios pendientes refleja el estado actual, con filtros de profesor/libro, independientemente del rango histórico mostrado.

El porcentaje conserva la regla institucional `(presentes + justificadas) / (presentes + ausentes + justificadas)`. Pendientes y suspensiones no forman parte del denominador. Se aplican feriados, excepciones, retiros y versiones de horario existentes. La comparación utiliza el período inmediatamente anterior con igual número de días. La evolución se agrupa por mes.

## Despliegue

1. Aplicar las migraciones en una rama de desarrollo, con `DATABASE_URL_UNPOOLED` directo: `npm run db:migrate` (alternativa: `node --import tsx scripts/migrate.ts`). Migraciones nuevas: 005, 006 y 007.
2. Configurar en Netlify, exclusivamente en el entorno de funciones:

| Variable | Valor inicial |
|---|---|
| `MACA_PROVIDER` | `gemini` |
| `GEMINI_API_KEY` | Clave privada de Gemini Developer API |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` |
| `MACA_DAILY_LIMIT` | `30` |
| `MACA_MINUTE_LIMIT` | `6` |

3. Ejecutar `npm run build`, desplegar la rama y probar con una sesión administrativa. Aplicar migraciones al entorno de destino antes de habilitar el nuevo código. Mantener la separación de base de datos de previews existente.
4. Verificar una pregunta real con Gemini y luego un error de cuota. La clave no está configurada en el entorno usado para esta implementación; las pruebas externas del proveedor utilizan dobles. Sin clave, Maca funciona mediante un clasificador determinista y lo identifica en la respuesta.

No hay claves `VITE_`, instalaciones de servicios adicionales ni activación automática de facturación. Google publica un nivel gratuito para 2.5 Flash-Lite, sujeto a disponibilidad y cuotas del proyecto: [precios oficiales](https://ai.google.dev/gemini-api/docs/pricing). Confirmar el nivel gratuito en AI Studio; una clave de un proyecto con facturación habilitada puede generar cargos aunque la aplicación limite sus llamadas.

## Seguridad y límites

- `POST /api/admin/maca`: autenticación de cookie y `requireAdmin` antes de cualquier consumo. Validación del origen como en el resto de la API. Profesores y anónimos reciben 403/401.
- Gemini Developer API oficial, salida JSON cerrada y validación Zod. Una llamada como máximo por pregunta aceptada, sin reintentos automáticos del proveedor. Tiempo máximo de red: 10 segundos; salida: 200 tokens.
- La frontera de privacidad admite únicamente palabras de una lista institucional fija (hasta 60 palabras, pregunta de hasta 600 caracteres). No salen nombres, IDs, fechas, cifras de asistencia, notas ni transcripciones. No se utiliza el texto del modelo como respuesta numérica ni SQL. Los resultados y nombres de tablas se resuelven internamente.
- Consultas analíticas predefinidas y parametrizadas dentro de una transacción PostgreSQL `REPEATABLE READ, READ ONLY`, con timeout de sentencia de 8 segundos. Las escrituras de metadatos de uso están separadas; Maca no puede modificar datos institucionales.
- `maca_requests` registra UUID de solicitud, hash de sesión, fecha, intentos de llamada, tokens reportados por Google y resultado. No registra preguntas ni respuestas. Los contadores sobreviven a logout/expiración. Limpieza oportunista después de 32 días; si no hay actividad, las filas pueden conservarse más tiempo.
- Cuotas globales para el administrador compartido, serializadas en PostgreSQL: 30 preguntas por día de Santiago y 6 en ventana móvil de un minuto. Incluyen preguntas aceptadas que luego fallan. No son las cuotas oficiales de Google. Un UUID repetido recibe 409 y no repite la llamada. El cliente bloquea envíos simultáneos.
- Caché estadística local de hasta 50 combinaciones y 30 segundos; no garantiza aciertos entre instancias de Netlify. Puede mostrar datos hasta 30 segundos anteriores. Tablas limitadas a 100 filas, rangos de hasta 366 días, sin fechas futuras. Protección de volumen: 300 libros, 10.000 matrículas, 150.000 registros de clase; al superarla se rechaza el análisis. Se reutiliza la carga institucional en lote existente; aún se leen datos históricos dentro de ese límite.
- Las solicitudes 429/errores de Gemini afectan solo Maca. Las funciones normales no dependen del proveedor. El uso de Netlify y su base, cuando corresponda, comparte el presupuesto de la cuenta: revisar métricas reales de funciones, transferencia y base; este código no impone un límite monetario al proveedor.

## Horarios y aprobaciones

La migración 006 añade disparadores en horarios, matrículas (fechas/libro) y cambios de profesor/duración del libro. Comprueba intervalos reales por fecha, versiones futuras y superposiciones entre libros del mismo profesor; intervalos contiguos se permiten. No se interpretan aulas físicas, porque el esquema actual no tiene ese recurso. Conflictos preexistentes no se corrigen automáticamente y pueden impedir una modificación posterior del registro involucrado.

Los cambios de horarios/matrículas y revisiones toman un bloqueo asesor antes de bloquear el libro; la restricción SQL también serializa estas escrituras. Las marcas ordinarias de asistencia conservan su bloqueo por libro. Al aprobar se vuelven a validar los conflictos y la vigencia de la solicitud; no se concede una excepción por haber sido propuesta antes. Un conflicto SQL se presenta como 409. Maca solo informa sobre estos estados.

## Validación reproducible

```sh
npm run build
npm test
RUN_INTEGRATION=true npm run test:integration
RUN_INTEGRATION=true npx vitest run tests/maca-database.test.ts
# Servidor local iniciado en 5173:
npx playwright test e2e/maca.spec.ts
node --import tsx scripts/benchmark-maca.ts
```

El benchmark solo admite development/preview y revierte todos sus datos. Escenario: 50 profesores, 1.100 matrículas, 5.500 registros mensuales. Una ejecución obtuvo 820 ms en carga SQL/calendario y 45 ms en agregación (865 ms total), con incremento observado de heap de 3,4 MiB. Se aplicó correctamente el feriado del 29 de junio: 4.400 presentes y 1.100 suspendidas. Incluye red y libros preexistentes; excluye Gemini, inicio en frío y costos de Netlify. Es una medición puntual, no un ensayo de 50 conexiones simultáneas ni una garantía de latencia.

Las pruebas cubren roles, privacidad del payload, inyección, cuotas, duplicados, uso reportado del proveedor, 429, respuesta de modelo inválida, fechas, pendientes/suspensiones, comparación SQL y restricción entre libros. El navegador usa respuestas simuladas a 390 y 1280 px y comprueba dos envíos simultáneos. El flujo previo de integración verifica el circuito de propuesta/aprobación completo.

Auditoría de uso, sin conversaciones:

```sql
SELECT (created_at AT TIME ZONE 'America/Santiago')::date AS dia,
       count(*) AS preguntas, sum(gemini_calls) AS intentos_gemini,
       sum(input_tokens) AS tokens_entrada, sum(output_tokens) AS tokens_salida
FROM maca_requests GROUP BY 1 ORDER BY 1 DESC;
```
