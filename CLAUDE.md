# NEXTEP — Notas del proyecto

## ⚠️ SEGURIDAD CRÍTICA — Dominios y qué se puede compartir

Arquitectura de portales (`nextstepasesor.com`):

| Dominio | Qué es | ¿Compartir con clientes? |
|---|---|---|
| `asi.nextstepasesor.com` | **ASI · Centro de Mando Neuronal** — el cerebro central de TODA la operación (CEO + agentes IA, hallazgos, salud, finanzas) | ❌ **NUNCA.** No se comparte, no se enlaza, no se compromete bajo ninguna circunstancia. |
| `admin.nextstepasesor.com` | Panel de administración interno | ❌ Interno. |
| `agent.nextstepasesor.com` | Portal de agentes/asesores | ❌ Interno. |
| `client.nextstepasesor.com` | **Portal del cliente** — ESTE es el único link de acceso que se envía a los clientes | ✅ Sí, este es el correcto. |
| `nextstepasesor.com` | Web pública | ✅ Público. |

**REGLA DE ORO:** cuando un cliente pide "el link de acceso a la plataforma", SIEMPRE es
`https://client.nextstepasesor.com`. **Jamás** enviar ni mencionar `asi.` (ASI / Centro de
Mando Neuronal) a un cliente — es el núcleo neural de todo y comprometerlo es una falla grave.
