# better-dgii-ecf

[English](README.md) · [Español](README.es.md)

> Plugin de [Better Auth](https://better-auth.com) para los servicios de facturación
> electrónica (**e-CF**) de la **DGII** de República Dominicana, construido sobre
> [`@deuriib/dgii-ecf`](https://www.npmjs.com/package/@deuriib/dgii-ecf).

[![npm](https://img.shields.io/npm/v/@deuriib/better-dgii-ecf.svg?label=npm)](https://www.npmjs.com/package/@deuriib/better-dgii-ecf)
[![CI](https://github.com/deuriib/better-dgii-ecf/actions/workflows/ci.yml/badge.svg)](https://github.com/deuriib/better-dgii-ecf/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`better-dgii-ecf` convierte el SDK de la DGII en una API autenticada. Decide **qué
contribuyente** actúa en cada petición, resuelve su certificado **en el servidor** y
registra cada transmisión para que un reintento no pueda emitir dos veces el mismo
comprobante fiscal.

Es un plugin, no un generador de documentos: tu aplicación modela la factura, el plugin
se encarga de la identidad, las credenciales, la idempotencia y la auditoría.

## ✨ Por qué existe

Una integración con la DGII tiene tres problemas que el framework de autenticación no
resuelve:

| Problema                        | Qué pasa sin el plugin                                                               | Qué hace el plugin                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **¿Quién factura?**             | El RNC viene del navegador, así que cualquiera factura como cualquier contribuyente. | Resuelve el contribuyente desde la organización, la petición o un mapeo del servidor, y luego lo autoriza.           |
| **¿Dónde vive el certificado?** | El `.p12` termina en el cliente o en cada cuerpo de petición.                        | Resuelve la llave por un callback exclusivo del servidor, firma en el servidor y nunca devuelve el token de la DGII. |
| **¿Llegó el comprobante?**      | Un timeout más un reintento emite dos veces el mismo e-NCF.                          | Escribe una fila `pending` antes de transmitir y reproduce el envío conocido en vez de repetirlo.                    |

## 📦 Instalación

```bash
bun add @deuriib/better-dgii-ecf @deuriib/dgii-ecf better-auth
# o: npm install @deuriib/better-dgii-ecf @deuriib/dgii-ecf better-auth
```

Dependencias peer: `better-auth@^1.7`, `@deuriib/dgii-ecf@^0.6`.

## 🚀 Inicio rápido — modo organización

El modo recomendado. El `taxPayerId` vive en la organización, así que el RNC con el que
un usuario puede facturar es el de la organización a la que pertenece.

```ts
// auth.ts
import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { P12Reader, Environment } from '@deuriib/dgii-ecf';
import { dgiiEcf, dgiiEcfOrganizationSchema } from '@deuriib/better-dgii-ecf';

export const auth = betterAuth({
  plugins: [
    organization({
      // Hace escribible el campo `taxPayerId` de la organización.
      schema: { organization: dgiiEcfOrganizationSchema() },
    }),
    dgiiEcf({
      environment: Environment.Cert,
      // El único lugar donde se lee un certificado. Se ejecuta en el servidor,
      // por contribuyente, nunca desde el cuerpo de una petición.
      credentials: async ({ taxPayerId }) => {
        const p12 = await certificates.for(taxPayerId); // tu almacenamiento
        return new P12Reader(p12.password)
          .getKeyFromStringBase64(p12.base64)
          .unwrapOrThrow();
      },
      status: { apiKey: process.env.DGII_STATUS_API_KEY! },
    }),
  ],
});
```

```ts
// auth-client.ts
import { createAuthClient } from 'better-auth/client';
import { organizationClient } from 'better-auth/client/plugins';
import { dgiiEcfClient } from '@deuriib/better-dgii-ecf/client';

export const authClient = createAuthClient({
  plugins: [organizationClient(), dgiiEcfClient()],
});
```

```ts
const { data, error } = await authClient.dgiiEcf.documents({
  xml: invoiceXml, // construido por tu aplicación
  sign: true, // firmado aquí, con la llave de la organización
});
```

## 🚀 Inicio rápido — modo por petición

Sin el plugin de organización: cada llamada indica su contribuyente. Es la forma de un
despliegue de un solo emisor, y funciona porque no hay un modelo de inquilino contra el
cual comparar el identificador.

```ts
dgiiEcf({
  environment: Environment.Dev,
  credentials: async () => loadSingleTenantCertificate(),
});
```

```ts
await auth.api.dgiiEcfSendDocument({
  body: { xml, sign: true, taxPayerId: '131123456' },
  headers,
});
```

Ambos modos son de primera clase; el
[orden de resolución](docs/usage.md#which-taxpayer-does-a-call-act-for) es fijo y
`GET /dgii-ecf/taxpayer` lo reporta, para que la interfaz nunca tenga que adivinar.

## 🔐 Postura de seguridad

- **Ningún certificado en el navegador.** La llave se resuelve por un callback del
  servidor; `sign: true` firma dentro del proceso que la tiene.
- **Ningún token de la DGII en la red.** `authenticate` devuelve `issuedAt` /
  `expiresAt`; el token no sale del servidor, ni siquiera en un cuerpo de error.
- **El emisor debe coincidir.** Un documento cuyo `RNCEmisor` difiere del contribuyente
  autorizado se rechaza.
- **Idempotente por construcción.** La llave de repetición es el SHA-256 del documento,
  y la fila `pending` se escribe antes de transmitir.
- **Nada fiscal en la tabla de auditoría.** Solo un hash, el e-NCF, el track id y la
  operación.

Lee [docs/security.md](docs/security.md) para el modelo de amenazas, incluido lo que el
plugin **no** protege a propósito.

## 🧪 Desarrollo

Todo corre por [mise](https://mise.jdx.dev) — local y en CI, con la misma cadena de
herramientas fijada.

```bash
mise install          # Node, Bun, pre-commit y gitleaks
mise run bootstrap    # dependencias + git hooks
mise run ci           # formato + tipos + cobertura + build + chequeos del paquete
mise tasks            # lista todas las tareas
```

## 📚 Documentación

- [Guía de uso](docs/usage.md) — modos, endpoints, repetición, errores
- [Arquitectura](docs/architecture.md) — ciclo de vida y modelo de datos
- [Seguridad](docs/security.md) — modelo de amenazas y garantías
- [Decisiones](docs/decisions.md) — por qué los valores por defecto son estos
- [Contribuir](CONTRIBUTING.md) · [Código de Conducta](CODE_OF_CONDUCT.md)

## ⚖️ Licencia

[MIT](LICENSE) © 2026 Deuri Vasquez.

> No está afiliado a la DGII. Es una implementación independiente de la especificación
> técnica pública del e-CF (Ley 32-23, Decreto 587-24). Valida siempre contra la
> [documentación oficial](https://dgii.gov.do/cicloContribuyente/facturacion/comprobantesFiscalesElectronicosE-CF/Paginas/default.aspx).
