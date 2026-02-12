import { BadRequestException, Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

const SALT_OR_ROUNDS = 10;

@Injectable()
export class BcryptEncryption {
  async encrypt(password: string) {
    try {
      return await bcrypt.hash(password, SALT_OR_ROUNDS);
    } catch (error) {
      throw new BadRequestException(`Error on encrypt: ${error}`);
    }
  }

  async compare(password: string, hash: string) {
    try {
      return await bcrypt.compare(password, hash);
    } catch (error) {
      throw new BadRequestException(`Error on decrypt: ${error}`);
    }
  }
}
