/**
 * Typed error classes for the codegen pipeline. See spec §4.2.1.
 *
 * Catch `OntologyGenError` to handle anything thrown by `lib/ontology-gen/`.
 * Each subclass exposes a stable `code` for log/grep, and HTTP-derived classes
 * additionally carry `httpStatus`.
 */

export abstract class OntologyGenError extends Error {
  abstract readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
  }
}

export class OntologyAuthError extends OntologyGenError {
  readonly code = "ontology-auth";
  readonly httpStatus = 401;
}

export class OntologyNotFoundError extends OntologyGenError {
  readonly code = "ontology-not-found";
  readonly httpStatus = 404;
  readonly resource: string;

  constructor(resource: string, message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.resource = resource;
  }
}

export class OntologyRequestError extends OntologyGenError {
  readonly code = "ontology-request";
  readonly httpStatus = 400;
}

export class OntologyUpstreamError extends OntologyGenError {
  readonly code = "ontology-upstream";
  readonly httpStatus = 502;
}

export class OntologyServerError extends OntologyGenError {
  readonly code = "ontology-server";
  readonly httpStatus = 500;
}

export class OntologyTimeoutError extends OntologyGenError {
  readonly code = "ontology-timeout";
  readonly timeoutMs: number;

  constructor(timeoutMs: number, message: string) {
    super(message);
    this.timeoutMs = timeoutMs;
  }
}

export class OntologyContractError extends OntologyGenError {
  readonly code = "ontology-contract";
}

export class ActionValidationError extends OntologyGenError {
  readonly code = "action-validation";
}
