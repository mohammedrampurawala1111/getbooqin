/** The app's equivalent of WP_Error — a typed, HTTP-status-carrying error. */
export class GetBooqinError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function isGetBooqinError(value: unknown): value is GetBooqinError {
  return value instanceof GetBooqinError;
}
