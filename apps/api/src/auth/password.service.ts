import { BadRequestException, Injectable } from "@nestjs/common";
import * as bcrypt from "bcryptjs";

const PASSWORD_HASH_ROUNDS = 12;
export const BCRYPT_MAX_PASSWORD_BYTES = 72;
export const BCRYPT_PASSWORD_INVALID_MESSAGE = "Senha invalida.";

/** bcrypt truncates after 72 UTF-8 bytes; reject instead of silently truncating. */
export function assertBcryptCompatiblePassword(password: string): void {
  if (Buffer.byteLength(password, "utf8") > BCRYPT_MAX_PASSWORD_BYTES) {
    throw new BadRequestException(BCRYPT_PASSWORD_INVALID_MESSAGE);
  }
}

@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    assertBcryptCompatiblePassword(password);
    return bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
  }

  async verify(password: string, hash: string): Promise<boolean> {
    assertBcryptCompatiblePassword(password);
    return bcrypt.compare(password, hash);
  }
}
