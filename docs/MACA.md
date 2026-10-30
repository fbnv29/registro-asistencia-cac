# Maca Asistente

Implementación sobre la arquitectura existente: React 19 + Vite + TypeScript, función Netlify `api`, PostgreSQL con `@neondatabase/serverless` por WebSocket. No se migró a Next.js. La configuración conecta directamente mediante `DATABASE_URL` a Neon; el código no integra el aprovisionamiento de Netlify Database. El origen de la facturación debe confirmarse en las cuentas del propietario.

## Uso

Administración → botón flotante «Maca» en la esquina inferior derecha. El chat abre como una ventana compacta, se minimiza desde la cabecera o con Escape y conserva la conversación al cambiar de sección administrativa. Los filtros se despliegan desde «Filtros»; Enter envía y Mayús+Enter agrega una línea. Preguntar por asistencia, profesores con registros, pendientes, suspensiones, solicitudes de horario, superposiciones o evolución mensual. Seleccionar libro/profesor para filtrar; los nombres escritos en el chat no actúan como filtros. Fechas explícitas ISO, meses en español, hoy, ayer, semana, mes y semestre se resuelven en el servidor. Los selectores de fecha prevalecen. El semestre corresponde a enero–junio o julio–diciembre; el período lectivo de cada libro limita las sesiones.

Las conversaciones existen únicamente en memoria del componente (hasta 20 intercambios); desaparecen al salir del panel administrativo o recargar. No se envía historial al proveedor. Las preguntas son independientes: repetir período y filtros cuando corresponda.

Una sesión es una clase individual de un estudiante. Una marca de ausencia acredita un registro, no que una clase se haya realizado físicamente. El conteo de profesores identifica libros con marcas, no al autor material de las marcas. La cola de cambios pendientes refleja el estado actual, con filtros de profesor/libro, independientemente del rango histórico mostrado.

El porcentaje conserva la regla institucional `(presentes + justificadas) / (presentes + ausentes + justificadas)`. Pendientes y suspensiones no forman parte del denominador. Se aplican feriados, excepciones, retiros y versiones de horario existentes. La comparación utiliza el período inmediatamente anterior con igual número de días. La evolución se agrupa por mes.

## Personalidad

Maca usa un tono cercano y divertido, con un chiste musical breve por respuesta exitosa. El humor se elige de un repertorio local y se presenta aparte de las cifras; no utiliza información de estudiantes o profesores ni requiere llamadas adicionales al proveedor. Los errores y límites se comunican de forma directa.

## Desarrollo local

Abrir `.env` en la raíz del proyecto y configurar:

```dotenv
MACA_PROVIDER=groq
GROQ_API_KEY=clave_privada
GROQ_MODEL=openai/gpt-oss-20b
```

Guardar y reiniciar `npm run dev`. El servidor existente carga `.env` con `dotenv/config`. El archivo está excluido de Git: no copiar la clave a `.env.example`, al chat o al código del navegador. La configuración local no se transmite automáticamente a Netlify. Para trabajar exclusivamente con el clasificador determinista, usar `MACA_PROVIDER=internal`; para volver a Google, usar `MACA_PROVIDER=gemini`, `GEMINI_API_KEY` y `GEMINI_MODEL`.

Groq se verificó con una llamada real al adaptador: clasificación JSON válida en 735 ms, 220 tokens de entrada y 45 de salida. El modelo admite salida JSON estricta. La aplicación no habilita herramientas, búsqueda ni acceso a la base para el proveedor. Referencias: [API oficial](https://console.groq.com/docs/api-reference), [salida estructurada](https://console.groq.com/docs/structured-outputs), [política de datos](https://console.groq.com/docs/your-data).

## Despliegue

1. Aplicar las migraciones en una rama de desarrollo, con `DATABASE_URL_UNPOOLED` directo: `npm run db:migrate` (alternativa: `node --import tsx scripts/migrate.ts`). Migraciones nuevas: 005–008.
2. Configurar en Netlify, exclusivamente en el entorno de funciones:

| Variable | Valor inicial |
|---|---|
| `MACA_PROVIDER` | `groq` (opciones: `groq`, `gemini`, `internal`) |
| `GROQ_API_KEY` | Clave privada de Groq |
| `GROQ_MODEL` | `openai/gpt-oss-20b` |
| `GEMINI_API_KEY` | Opcional, solo con proveedor `gemini` |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` |
| `MACA_DAILY_LIMIT` | `30` |
| `MACA_MINUTE_LIMIT` | `6` |

3. Ejecutar `npm run build`, desplegar la rama y probar con una sesión administrativa. Aplicar migraciones al entorno de destino antes de habilitar el nuevo código. Mantener la separación de base de datos de previews existente.
4. Verificar una pregunta real con Groq y luego simular un error de cuota. En desarrollo se verificaron preguntas completas con Groq y PostgreSQL (HTTP 200), incluida la cola de aprobaciones contrastada con SQL. Una ejecución completa tardó 2.892 ms. Las pruebas locales cubren cuotas, red, permisos y respuestas malformadas mediante dobles. Sin clave o ante errores externos, Maca utiliza su clasificador determinista y lo identifica en `source` y `fallback`. Las preguntas deben ser explícitas; el respaldo no interpreta contexto de mensajes previos. No cambia automáticamente a otro proveedor externo.

Gemini queda como opción configurable: en la prueba real del proyecto de desarrollo devolvió 402 pese a que el panel mostraba nivel gratuito. No se confirmó la causa ni se activó facturación. Maca local utiliza Groq y no envía llamadas a Google mientras `MACA_PROVIDER=groq`.


No hay claves `VITE_`, instalaciones de servicios adicionales ni activación automática de facturación. Groq publica límites gratuitos por modelo: [límites oficiales](https://console.groq.com/docs/rate-limits). Mantener la cuenta en Free; la aplicación no puede comprobar ni modificar el plan de facturación. Google publica un nivel gratuito para 3.5 Flash-Lite, sujeto a disponibilidad y cuotas del proyecto: [precios oficiales](https://ai.google.dev/gemini-api/docs/pricing). Confirmar el nivel gratuito en AI Studio; una clave de un proyecto con facturación habilitada puede generar cargos aunque la aplicación limite sus llamadas.

## Seguridad y límites

- `POST /api/admin/maca`: autenticación de cookie y `requireAdmin` antes de cualquier consumo. Validación del origen como en el resto de la API. Profesores y anónimos reciben 403/401.
- Adaptadores para las API oficiales de Groq y Gemini, salida JSON cerrada y validación Zod. Una llamada como máximo por pregunta aceptada, sin reintentos automáticos del proveedor. Tiempo máximo de red: 10 segundos; salida: 512 tokens totales en Groq (incluido razonamiento, esfuerzo bajo), 200 en Gemini.
- La frontera de privacidad admite únicamente palabras de una lista institucional fija (hasta 60 palabras, pregunta de hasta 600 caracteres). No salen nombres, IDs, fechas, cifras de asistencia, notas ni transcripciones. No se utiliza el texto del modelo como respuesta numérica ni SQL. Los resultados y nombres de tablas se resuelven internamente.
- Consultas analíticas predefinidas y parametrizadas dentro de una transacción PostgreSQL `REPEATABLE READ, READ ONLY`, con timeout de sentencia de 8 segundos. Las escrituras de metadatos de uso están separadas; Maca no puede modificar datos institucionales.
- `maca_requests` registra UUID de solicitud, hash de sesión, fecha, intentos de llamada, tokens reportados por el proveedor y resultado. La migración 008 añade `groq_calls`, `provider` y `fallback_reason`; `gemini_calls` sigue contando únicamente intentos a Google. No registra preguntas ni respuestas. Los contadores sobreviven a logout/expiración. Limpieza oportunista después de 32 días; si no hay actividad, las filas pueden conservarse más tiempo.
- Cuotas globales para el administrador compartido, serializadas en PostgreSQL: 30 preguntas por día de Santiago y 6 en ventana móvil de un minuto. Incluyen preguntas aceptadas que luego fallan. No son las cuotas oficiales de Google. Un UUID repetido recibe 409 y no repite la llamada. El cliente bloquea envíos simultáneos.
- Caché estadística local de hasta 50 combinaciones y 30 segundos; no garantiza aciertos entre instancias de Netlify. Puede mostrar datos hasta 30 segundos anteriores. Tablas limitadas a 100 filas, rangos de hasta 366 días, sin fechas futuras. Protección de volumen: 300 libros, 10.000 matrículas, 150.000 registros de clase; al superarla se rechaza el análisis. Se reutiliza la carga institucional en lote existente; aún se leen datos históricos dentro de ese límite.
- Los errores del proveedor activan el respaldo interno, sin reintentos ni llamadas adicionales a otros proveedores. Las cuotas internas de la aplicación siguen devolviendo 429 y no se eluden con el respaldo. Las funciones normales no dependen del proveedor. El uso de Netlify y su base, cuando corresponda, comparte el presupuesto de la cuenta: revisar métricas reales de funciones, transferencia y base; este código no impone un límite monetario al proveedor.

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

El benchmark solo admite development/preview y revierte todos sus datos. Escenario: 50 profesores, 1.100 matrículas, 5.500 registros mensuales. Una ejecución obtuvo 820 ms en carga SQL/calendario y 45 ms en agregación (865 ms total), con incremento observado de heap de 3,4 MiB. Se aplicó correctamente el feriado del 29 de junio: 4.400 presentes y 1.100 suspendidas. Incluye red y libros preexistentes; excluye llamadas al proveedor, inicio en frío y costos de Netlify. Es una medición puntual, no un ensayo de 50 conexiones simultáneas ni una garantía de latencia.

Las pruebas cubren selección de proveedor, respaldo interno, distinción entre aprobaciones y asistencia pendiente, roles, privacidad del payload, inyección, cuotas, duplicados, uso reportado del proveedor, 429, respuesta de modelo inválida, fechas, pendientes/suspensiones, comparación SQL y restricción entre libros. El navegador usa respuestas simuladas a 390 y 1280 px y comprueba dos envíos simultáneos. El flujo previo de integración verifica el circuito de propuesta/aprobación completo.

Auditoría de uso, sin conversaciones:

```sql
SELECT (created_at AT TIME ZONE 'America/Santiago')::date AS dia,
       count(*) AS preguntas, sum(gemini_calls) AS intentos_gemini, sum(groq_calls) AS intentos_groq,
       sum(input_tokens) AS tokens_entrada, sum(output_tokens) AS tokens_salida
FROM maca_requests GROUP BY 1 ORDER BY 1 DESC;
```

La interpretación aplica reglas locales de prioridad para aprobaciones, superposiciones y evolución; una clasificación del modelo no puede confundir esas consultas con asistencia pendiente.
