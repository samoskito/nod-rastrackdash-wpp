/** Thrown by LicenseClientService.activate() when the server reports the key is bound to a different account. */
export class LicenseAccountMismatchError extends Error {
  constructor(message = "License is bound to a different account") {
    super(message);
    this.name = "LicenseAccountMismatchError";
  }
}
