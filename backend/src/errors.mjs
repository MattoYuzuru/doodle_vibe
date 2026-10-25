export class AppError extends Error {
  constructor(code, status = 400, message = code) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}
