export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'conflict', 409, details);
    this.name = 'ConflictError';
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, 'not_found', 404, { entity, id });
    this.name = 'NotFoundError';
  }
}

export class RetriableAgentError extends Error {
  constructor(message: string, readonly stage: string) {
    super(message);
    this.name = 'RetriableAgentError';
  }
}

export class PermanentAgentError extends Error {
  constructor(message: string, readonly stage: string) {
    super(message);
    this.name = 'PermanentAgentError';
  }
}
