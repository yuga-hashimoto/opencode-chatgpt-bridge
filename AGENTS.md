# IA DEV — AGENTS.md

## Propósito
Bridge local que permite a ChatGPT controlar sesiones de `opencode` en el repositorio. Facilita tareas de código con verificación Git física y perfiles de permisos `.ia-dev.yml`.

## Comandos estándar
```bash
pnpm install
pnpm run typecheck    # TypeScript strict mode
pnpm test             # Unit tests (vitest)
pnpm run build        # Production build
pnpm run validate     # Runs all three above
```

## Arquitectura clave

### Git físico como source of truth
- `repo_git_status` y `repo_git_diff` leen el repositorio Git directamente.
- `opencode_vcs_status` y `opencode_get_diff` devuelven la vista interna de opencode, que **puede no coincidir** con el filesystem físico.
- Una tarea de escritura solo se considera completa cuando `git status` y `git diff` muestran cambios físicos.

### Session-Server Binding
- Cada sesión bridge guarda su `baseUrl` (servidor opencode en el que fue creada).
- Antes de operaciones específicas de sesión, el puente compara:
  `persistedSession.baseUrl === currentManagedServer.baseUrl`
- Si difiere, intenta **recovery fail-closed** (`src/opencode/recovery.ts`):
  1. Pide al servidor actual la sesión por `opencodeSessionId`
  2. El `id` debe igualarse y `session.directory` debe realpath-matchear el `repoPath` persistido
  3. Solo entonces se rebinde el `baseUrl`
- Operations que **verifican** el binding: `opencode_get_session_status`, `opencode_send_message`, `opencode_get_messages`, `opencode_get_diff`, `opencode_abort`, `opencode_respond_permission`, `opencode_wait_for_session`.
- Operations que **no verifican** (nivel repo): `opencode_read_file`, `opencode_find_files`, `opencode_vcs_status`, `opencode_capabilities`, `list_projects`, `opencode_start`, `repo_git_status`, `repo_git_diff`.

### Política free-only fail-closed
- Antes de enviar cualquier prompt, el puente verifica que el modelo tenga costo cero en input, output y cache_read/cache_write leyendo el inventario `/provider` del servidor gestionado.
- Si la verificación falla, el prompt **no se envía** (falla cerrado).
- Después de completar, se verifica el usage observado desde los metadatos de los mensajes assistant. Falla cerrado si falta evidencia de costos cero.
- No hay author fallback: el registro tiene dos modelos (author/reviewer); un rechazo por quota (HTTP 429/402) detiene la tarea sin reintentar bajo otro modelo.

### .ia-dev.yml como perfil de permisos
- El esquema vive en `src/config/schema.ts`, validación y checks en `src/security/profile.ts`.
- Modelo `author` y `reviewer` deben ser diferentes y pertenecer al registro de modelos free.
- 4-list model: `context_paths` (legible), `write_paths` (modificable, vacío = sin escrituras), `protected_paths` (nunca escribibles), `sensitive_paths` (nunca leibles).
- `ia_dev_run_task` y `opencode_launch_task`/`opencode_send_message` fallan antes de enviar cualquier prompt si el profile falta o `write_paths` está vacío.

### No trabajar directamente sobre main
- `ia_dev_run_task` y `opencode_launch_task` bloquean por defecto la escritura sobre rama `main`/`master` (check `assertNotMain`).
- `allowMain: true` disponible pero explícito.

### Flujo ejecutar → verificar → revisar → PR
1. `ia_dev_run_task` valida repo, bloquea main, carga perfil, captura estado Git inicial
2. Crea sesión opencode, envía prompt async, espera estado terminal
3. Compara snapshot Git físico antes/después: `gitChanged`, `gitVerification` (HEAD, clean, diff, status)
4. Verifica que los paths modificados satisfagan la política de `write_paths` del perfil
5. Verifica observed usage de modelos free desde los messages del session
6. Retorna `success: true` solo si: terminal idle/completed **Y** `gitChanged: true` **Y** sin paths denied por policy
7. El revisor humano inspecciona `get_diff` antes de commit o push.

### Prohibiciones
- **No merge/deploy automático**: El bridge nunca hace merge o deploy. El flujo termina con `success: true` y diffs first-class para revisión humana.
- **No asumir que OpenCode diff sustituye a Git físico**: `opencode_get_diff` es la vista interna; la autoridad es `repo_git_diff`/`repo_git_status`.
- **No almacenar historia, logs ni estado de fase en AGENTS.md**: contiene solo reglas permanentes. Logs van a `~/.opencode-chatgpt-bridge/bridge.log`/`bridge.err.log`. Estado de fase corre por `NEXT-PHASE-PROMPT.md` y `PROJECT-CONTEXT.md`.
- **PROJECT-CONTEXT.md es la fuente del estado actual**: branch, PRs abiertos, deudas resueltas, preguntas abiertas.
- **NEXT-PHASE-PROMPT.md es la entrada de la siguiente fase**: decisiones pendientes, próxima ejecución.

## Flujo de trabajo típico
```bash
# 1. Instalar y configurar
pnpm install
pnpm run init -- --allowed-roots /ruta/a/repos
pnpm run install-service  # modo background macOS opcional

# 2. Desde ChatGPT usar conectores:
# - Connector URL: https://<tunnel>.trycloudflare.com/mcp?token=<token>
# - O usar auth header: Authorization: Bearer <OPENCODE_BRIDGE_TOKEN>

# 3. Ejecutar tarea
# ChatGPT: "Usa opencode local bridge. Llama bridge_health, list_projects, create_session para /ruta/repo,
# ask opencode a fix, poll status, show diff."

# 4. Revisar cambios via repo_git_diff antes de commit
```