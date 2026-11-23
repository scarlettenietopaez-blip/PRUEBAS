# ALLPA · FirmaEC · Edge Functions V8.4.2

## Funciones

- `firmaec-iniciar`: valida la sesión de ALLPA dentro del código, recupera el PDF y solicita a FirmaEC un token para iniciar la firma.
- `firmaec-retorno`: callback servidor-a-servidor que recibe el PDF firmado desde FirmaEC y valida la `X-API-KEY`.

## Autenticación

`config.toml` usa `verify_jwt = false` en ambas funciones. Esto no vuelve pública la operación sensible:

- `firmaec-iniciar` valida explícitamente el JWT del usuario mediante `auth.getUser()`.
- `firmaec-retorno` exige la `X-API-KEY` registrada para FirmaEC.

## Secretos

No subir valores reales a GitHub. Configurarlos en Supabase Dashboard > Edge Function Secrets:

- `FIRMAEC_API_URL`
- `FIRMAEC_API_KEY`
- `FIRMAEC_SISTEMA`
- `FIRMAEC_PRE`
- `FIRMAEC_CALLBACK_API_KEY`

Las variables `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` son provistas por Supabase en el entorno alojado.
