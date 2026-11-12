import { err, ok, TrackStatusEnum } from '@deuriib/dgii-ecf';
import type {
  B2BCommercialApprovalResponse,
  CommercialApprovalResponse,
  ECF,
  InquiryInvoiceSummary,
  InquiryStatusResponse,
  InvoiceResponse,
  InvoiceSummaryResponse,
  MaintenanceWindow,
  ReconciliationResult,
  ServiceAvailabilityResponse,
  ServiceDirectoryResponse,
  ServiceStatusEntry,
  SummaryTrackingStatusResponse,
  TrackingStatusResponse,
  VoidNCFResponse,
} from '@deuriib/dgii-ecf';
import { DgiiError } from '@deuriib/dgii-ecf';

/**
 * Real identifiers, taken from DGII's public taxpayer registry
 * (`RNC_CONTRIBUYENTES.zip`, 07 Nov 2026).
 *
 * They are used instead of invented numbers because the default validation is now
 * a check digit: a made-up RNC no longer passes, and a fixture that only works
 * with validation disabled would test the wrong thing. Only the numbers are
 * recorded here — the registry also carries razón social, which is personal data
 * and does not belong in a repository.
 */
export const TAXPAYER_A = '531058447';
export const TAXPAYER_B = '505074758';
export const CEDULA = '02601322098';
/** Same RNC as {@link TAXPAYER_A}, written the way a human types it. */
export const TAXPAYER_A_FORMATTED = '5-31-05844-7';
/** 9 digits, valid shape, wrong check digit — the digit next to TAXPAYER_A. */
export const TAXPAYER_INVALID_CHECKSUM = '531058448';

export interface RecordedCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export const documentXml = (
  rnc: string,
  encf = 'E310000000001',
  root = 'ECF',
): string =>
  `<?xml version="1.0" encoding="UTF-8"?><${root}><Encabezado><Emisor><RNCEmisor>${rnc}</RNCEmisor></Emisor><IdDoc><eNCF>${encf}</eNCF></IdDoc></Encabezado></${root}>`;

export const anecfXml = (rnc: string, desde = 'E310000000010'): string =>
  `<?xml version="1.0" encoding="UTF-8"?><ANECF><RncEmisor>${rnc}</RncEmisor><SecuenciaeNCFDesde>${desde}</SecuenciaeNCFDesde></ANECF>`;

export interface FakeEcfOptions {
  /** Force every call to fail with this error. */
  failWith?: DgiiError;
  /** Override individual method implementations. */
  overrides?: Record<string, unknown>;
}

/**
 * A stand-in for `ECF` that records the arguments of every call.
 *
 * The plugin's job is wiring, authorization and durability — the DGII protocol
 * belongs to the SDK. A recording double is therefore the honest test surface:
 * it proves which taxpayer each call was made for, and it makes DGII failure
 * mapping testable without a network.
 */
export const createFakeEcf = (options: FakeEcfOptions = {}) => {
  const calls: RecordedCall[] = [];

  const record = (method: string, args: unknown[], value: unknown): unknown => {
    calls.push({ method, args });
    if (options.failWith !== undefined) {
      return err(options.failWith);
    }
    return ok(value);
  };

  const base = {
    authenticate: async (...args: unknown[]) =>
      record('authenticate', args, {
        token: 'dgii-token-that-must-never-be-returned',
        expedido: '2026-01-01T00:00:00Z',
        expira: '2026-01-01T01:00:00Z',
      }),
    getServiceStatus: async (...args: unknown[]) =>
      record('getServiceStatus', args, [
        { servicio: 'recepcion', estatus: 'Disponible', ambiente: 'TesteCF' },
      ] satisfies ServiceStatusEntry[]),
    getMaintenanceWindows: async (...args: unknown[]) =>
      record('getMaintenanceWindows', args, [
        { ambiente: 'TesteCF', horaInicio: '22:00', horaFin: '23:00', dias: ['lunes'] },
      ] satisfies MaintenanceWindow[]),
    checkServiceAvailability: async (...args: unknown[]) =>
      record('checkServiceAvailability', args, {
        estado: 'Disponible',
      } satisfies ServiceAvailabilityResponse),
    sendDocument: async (...args: unknown[]) =>
      record('sendDocument', args, {
        trackId: 'track-document',
      } satisfies InvoiceResponse),
    sendElectronicDocument: async (...args: unknown[]) =>
      record('sendElectronicDocument', args, {
        trackId: 'track-electronic',
      } satisfies InvoiceResponse),
    sendSummary: async (...args: unknown[]) =>
      record('sendSummary', args, {
        codigo: 1,
        estado: 'Aceptado',
        encf: 'E320000000001',
        secuenciaUtilizada: false,
      } satisfies InvoiceSummaryResponse),
    sendCommercialApproval: async (...args: unknown[]) =>
      record('sendCommercialApproval', args, {
        codigo: '1',
        estado: 'Aprobación comercial aprobada',
        mensaje: [],
      } satisfies CommercialApprovalResponse | B2BCommercialApprovalResponse),
    voidENCF: async (...args: unknown[]) =>
      record('voidENCF', args, {
        rnc: TAXPAYER_A,
        codigo: '0',
        nombre: 'Anulación',
        mensajes: [],
      } satisfies VoidNCFResponse),
    reconcileSubmission: async (...args: unknown[]) =>
      record('reconcileSubmission', args, {
        inquiry: { codigo: 1, estado: 'Aceptado' },
        delivered: true,
        canReuseSequence: false,
        cleared: false,
      } satisfies ReconciliationResult),
    statusTrackId: async (...args: unknown[]) =>
      record('statusTrackId', args, {
        trackId: 'track-1',
        codigo: 1,
        estado: TrackStatusEnum.Accepted,
        rnc: TAXPAYER_A,
        encf: 'E310000000001',
        fechaRecepcion: '2026-01-01T00:00:00Z',
      } satisfies TrackingStatusResponse),
    inquiryStatus: async (...args: unknown[]) =>
      record('inquiryStatus', args, {
        codigo: 1,
        estado: 'Aceptado',
      } satisfies InquiryStatusResponse),
    trackStatuses: async (...args: unknown[]) =>
      record('trackStatuses', args, [
        {
          trackId: 'track-1',
          estado: 'Aceptado',
          fechaRecepcion: '2026-01-01T00:00:00Z',
        },
      ] satisfies SummaryTrackingStatusResponse[]),
    getSummaryInvoiceInquiry: async (...args: unknown[]) =>
      record('getSummaryInvoiceInquiry', args, {
        rnc: TAXPAYER_A,
        encf: 'E320000000001',
        secuenciaUtilizada: false,
        codigo: 1,
        estado: 'Aceptado',
      } satisfies InquiryInvoiceSummary),
    getCustomerDirectory: async (...args: unknown[]) =>
      record('getCustomerDirectory', args, [
        {
          nombre: 'Receptor',
          rnc: TAXPAYER_B,
          urlRecepcion: 'https://example.test/recepcion',
          urlAceptacion: 'https://example.test/aceptacion',
          urlOpcional: 'https://example.test/opcional',
        },
      ] satisfies ServiceDirectoryResponse[]),
    getDirectoryListing: async (...args: unknown[]) =>
      record('getDirectoryListing', args, [] satisfies ServiceDirectoryResponse[]),
  };

  const client = {
    ...base,
    ...options.overrides,
    calls,
    /** Methods invoked, in order. */
    methodNames: (): string[] => calls.map((call) => call.method),
  };

  return client as unknown as ECF & {
    calls: RecordedCall[];
    methodNames: () => string[];
  };
};

/** Valid PEM-shaped garbage: enough for the provider, never used to sign. */
export const fakeCredentials = { key: 'fake-key', cert: 'fake-cert' };
